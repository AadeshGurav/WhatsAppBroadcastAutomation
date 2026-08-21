import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ScrapedArticle } from '@database/entities/wa-automation/scraped-article.entity';
import { ArticleHash } from '@database/entities/wa-automation/article-hash.entity';
import { ScraperActivityLog } from '@database/entities/wa-automation/scraper-activity-log.entity';
import { ParserRegistryService } from './parsers/parser-registry.service';
import { GenericParser } from './parsers/built-in/generic.parser';
import { ChangeDetectorService } from './change-detector.service';
import { IArticleParser, ParsedArticle } from './parsers/parser.interface';
import { BrowserFetchUtil } from '@common/utils/browser-fetch.util';

@Injectable()
export class ScraperService {
  private readonly logger = new Logger('ScraperService');
  private readonly fetcher: typeof fetch;
  private readonly failedArticleUrls = new Map<string, number>();
  private readonly FAILED_RETRY_TTL_MS = 3_600_000; // 1 hour
  private readonly MAX_RETRIES_PER_URL = 3;

  constructor(
    @InjectRepository(ScrapedArticle, 'data')
    private readonly articleRepo: Repository<ScrapedArticle>,
    @InjectRepository(ArticleHash, 'data')
    private readonly hashRepo: Repository<ArticleHash>,
    @InjectRepository(ScraperActivityLog, 'data')
    private readonly activityRepo: Repository<ScraperActivityLog>,
    private readonly parserRegistry: ParserRegistryService,
    private readonly changeDetector: ChangeDetectorService,
    private readonly configService: ConfigService,
  ) {
    this.fetcher = globalThis.fetch.bind(globalThis);
    // Register built-in parsers
    this.parserRegistry.register(new GenericParser());
  }

  getTargetUrls(): string[] {
    const urls = this.configService.get<string>('scraper.targetUrls', '');
    if (urls) return urls.split(',').map(u => u.trim()).filter(Boolean);
    return [];
  }

  async fetchPageContent(url: string, timeout = 30_000): Promise<string> {
    return BrowserFetchUtil.fetchWithFallback(url, timeout);
  }

  async detectAndStoreChange(url: string): Promise<ScrapedArticle | null> {
    this.logger.log(`Checking hash-based change for: ${url}`);
    const html = await this.fetchPageContent(url);
    const newHash = this.changeDetector.hashContent(html);

    const existing = await this.hashRepo.findOne({ where: { url } });
    if (existing && !this.changeDetector.hasChanged(existing.contentHash, html)) {
      return null; // No change
    }

    // Update or create hash
    if (existing) {
      existing.contentHash = newHash;
      await this.hashRepo.save(existing);
    } else {
      await this.hashRepo.save(this.hashRepo.create({ url, contentHash: newHash }));
    }

    // Parse and store article
    const parser = this.parserRegistry.getParserForUrl(url) || new GenericParser();
    const parsed = parser.parseArticle(html, url);
    return this.storeArticle(parsed);
  }

  private async fetchWithRetry(url: string, maxRetries = 3): Promise<string> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.fetchPageContent(url);
      } catch (err: any) {
        if (attempt === maxRetries) throw err;
        const delay = Math.pow(2, attempt) * 1000;
        
        // Extract cause if it's a fetch error (like ECONNRESET)
        const causeMsg = err.cause ? ` (Cause: ${err.cause.message || err.cause.code || err.cause})` : '';
        this.logger.warn(`Retry ${attempt}/${maxRetries} for ${url} in ${delay}ms: ${err.message}${causeMsg}`);
        
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Retry previously failed article URLs. Called at the start of each scraper cycle
   * so transient failures get another chance without waiting for the listing page to change.
   */
  async retryFailedArticleUrls(parser: IArticleParser = new GenericParser()): Promise<ScrapedArticle[]> {
    const now = Date.now();
    const results: ScrapedArticle[] = [];

    for (const [url, failedCount] of this.failedArticleUrls) {
      if (now - this.FAILED_RETRY_TTL_MS > 3_600_000) {
        // Bogus TTL fallback — cap at 1 hour since first failure
        this.failedArticleUrls.delete(url);
        continue;
      }

      if (failedCount >= this.MAX_RETRIES_PER_URL) {
        this.logger.warn(`Giving up on ${url} after ${failedCount} failed retries`);
        this.failedArticleUrls.delete(url);
        continue;
      }

      try {
        const articleHtml = await this.fetchWithRetry(url);
        const parsed = parser.parseArticle(articleHtml, url);

        if (parsed.publishedAt) {
          const ageHours = (Date.now() - parsed.publishedAt.getTime()) / 3_600_000;
          if (ageHours > 24) {
            this.failedArticleUrls.delete(url);
            continue;
          }
        }

        const stored = await this.storeArticle(parsed);
        results.push(stored);

        const hash = this.changeDetector.hashContent(articleHtml);
        await this.hashRepo.save(this.hashRepo.create({ url, contentHash: hash }));

        this.failedArticleUrls.delete(url);
        this.logger.log(`Retry succeeded: stored article "${parsed.title}" from ${url}`);
      } catch (err) {
        this.failedArticleUrls.set(url, failedCount + 1);
        this.logger.warn(`Retry ${failedCount + 1}/${this.MAX_RETRIES_PER_URL} failed for ${url}: ${(err as Error).message}`);
      }
    }

    return results;
  }

  async detectNewArticles(url: string, parser: IArticleParser): Promise<ScrapedArticle[]> {
    this.logger.log(`Listing-based detection for: ${url}`);
    const html = await this.fetchPageContent(url);
    const previews = parser.parseListing(html, url);

    const articles: ScrapedArticle[] = [];
    for (const preview of previews) {
      const existingHash = await this.hashRepo.findOne({ where: { url: preview.url } });
      if (existingHash) continue; // Already seen

      try {
        const articleHtml = await this.fetchPageContent(preview.url);
        const parsed = parser.parseArticle(articleHtml, preview.url);
        const stored = await this.storeArticle(parsed);
        articles.push(stored);

        // Mark as seen
        const hash = this.changeDetector.hashContent(articleHtml);
        await this.hashRepo.save(this.hashRepo.create({ url: preview.url, contentHash: hash }));
      } catch (err) {
        this.logger.warn(`Failed to fetch/parse ${preview.url}: ${(err as Error).message}`);
      }
    }
    return articles;
  }

  private async storeArticle(parsed: ParsedArticle): Promise<ScrapedArticle> {
    const article = this.articleRepo.create({
      url: parsed.url,
      title: parsed.title,
      description: parsed.description,
      body: parsed.body,
      imageUrl: parsed.imageUrl,
      sourceName: parsed.sourceName,
      publishedAt: parsed.publishedAt,
      bulletPoints: parsed.bulletPoints?.length ? parsed.bulletPoints : null,
    });
    return this.articleRepo.save(article);
  }

  async getRecentArticles(limit = 50): Promise<ScrapedArticle[]> {
    return this.articleRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getArticleCount(): Promise<number> {
    return this.articleRepo.count();
  }

  async getArticle(id: number): Promise<ScrapedArticle | null> {
    return this.articleRepo.findOne({ where: { id } });
  }

  async unseedArticles(): Promise<void> {
    await this.hashRepo.clear();
  }

  async scrapeAllTargetUrls(): Promise<ScrapedArticle[]> {
    const urls = this.getTargetUrls();
    const results: ScrapedArticle[] = [];
    const parser = new GenericParser();
    for (const url of urls) {
      try {
        const articles = await this.detectFromListing(url, parser);
        results.push(...articles);
      } catch (err) {
        this.logger.warn(`Scrape failed for ${url}: ${(err as Error).message}`);
      }
    }
    return results;
  }

  /**
   * Log a scraper activity entry for transparency/audit.
   */
  async logActivity(log: {
    url: string;
    articlesFound: number;
    articlesNew: number;
    articlesSkipped: number;
    articlesFailed: number;
    listingChanged: boolean;
    errors?: string[];
    durationMs: number;
  }): Promise<void> {
    try {
      await this.activityRepo.save(this.activityRepo.create({
        url: log.url,
        articlesFound: log.articlesFound,
        articlesNew: log.articlesNew,
        articlesSkipped: log.articlesSkipped,
        articlesFailed: log.articlesFailed,
        listingChanged: log.listingChanged,
        errors: log.errors?.length ? log.errors.join('; ') : null,
        durationMs: log.durationMs,
      }));
    } catch (err) {
      this.logger.warn(`Failed to save activity log: ${(err as Error).message}`);
    }
  }

  /**
   * Detect new articles from a listing page URL.
   * Uses parser.parseListing to find article URLs, then fetches and parses each one.
   * Logs activity for transparency/audit.
   */
  async detectFromListing(url: string, parser: IArticleParser): Promise<ScrapedArticle[]> {
    this.logger.log(`Checking listing page: ${url}`);
    const startTime = Date.now();
    let listingChanged = false;
    let articlesFound = 0;
    let articlesFailed = 0;
    const errorList: string[] = [];

    try {
      const html = await this.fetchWithRetry(url);
      const newHash = this.changeDetector.hashContent(html);

      const existing = await this.hashRepo.findOne({ where: { url } });
      if (existing && !this.changeDetector.hasChanged(existing.contentHash, html)) {
        this.logger.log(`No change detected on listing page: ${url}`);
        // Only persist an activity row when something actually happened —
        // a "no change" write every minute is ~1,440 rows/day of churn that
        // burns Neon compute for no signal.
        if (process.env.SCRAPER_LOG_NO_CHANGE === 'true') {
          await this.logActivity({
            url, articlesFound: 0, articlesNew: 0, articlesSkipped: 0,
            articlesFailed: 0, listingChanged: false,
            durationMs: Date.now() - startTime,
          });
        }
        return [];
      }

      listingChanged = true;

      // Update or create hash for the listing page itself
      if (existing) {
        existing.contentHash = newHash;
        await this.hashRepo.save(existing);
      } else {
        await this.hashRepo.save(this.hashRepo.create({ url, contentHash: newHash }));
      }

      // Extract article previews from the listing
      const previews = parser.parseListing(html, url);
      articlesFound = previews.length;

      if (previews.length === 0) {
        this.logger.warn(`No articles found on listing page: ${url}`);
        await this.logActivity({
          url, articlesFound: 0, articlesNew: 0, articlesSkipped: 0,
          articlesFailed: 0, listingChanged: true,
          errors: ['Parser returned no article previews'],
          durationMs: Date.now() - startTime,
        });
        return [];
      }

      this.logger.log(`Found ${previews.length} article(s) on listing page`);

      const articles: ScrapedArticle[] = [];
      let skipped = 0;
      for (const preview of previews) {
        // Check if we've already seen this article URL
        const existingHash = await this.hashRepo.findOne({ where: { url: preview.url } });
        if (existingHash) {
          skipped++;
          continue;
        }

        try {
          const articleHtml = await this.fetchWithRetry(preview.url);
          const parsed = parser.parseArticle(articleHtml, preview.url);

          // Skip articles older than 24 hours (not today's news)
          if (parsed.publishedAt) {
            const ageHours = (Date.now() - parsed.publishedAt.getTime()) / 3_600_000;
            if (ageHours > 24) {
              this.logger.log(`Skipping old article (${ageHours.toFixed(1)}h old): ${parsed.title}`);
              await this.hashRepo.save(
                this.hashRepo.create({ url: preview.url, contentHash: 'skip-old' }),
              ).catch(() => {});
              skipped++;
              continue;
            }
          }

          const stored = await this.storeArticle(parsed);
          articles.push(stored);

          // Mark as seen
          const hash = this.changeDetector.hashContent(articleHtml);
          await this.hashRepo.save(this.hashRepo.create({ url: preview.url, contentHash: hash }));
        } catch (err) {
          articlesFailed++;
          const msg = `${preview.url}: ${(err as Error).message}`;
          errorList.push(msg);
          this.logger.warn(`Failed to fetch/parse ${preview.url}: ${(err as Error).message}`);
          // Track failed URL for retry on next cycle
          this.failedArticleUrls.set(preview.url, 0);
        }
      }

      await this.logActivity({
        url,
        articlesFound,
        articlesNew: articles.length,
        articlesSkipped: skipped,
        articlesFailed,
        listingChanged: true,
        errors: errorList.length > 0 ? errorList : undefined,
        durationMs: Date.now() - startTime,
      });

      return articles;
    } catch (err) {
      await this.logActivity({
        url,
        articlesFound: 0,
        articlesNew: 0,
        articlesSkipped: 0,
        articlesFailed: 0,
        listingChanged: false,
        errors: [`Listing page error: ${(err as Error).message}`],
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }
}
