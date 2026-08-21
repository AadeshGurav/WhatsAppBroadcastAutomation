/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EngineFactory } from '@whatsapp-engine/engine.factory';
import { RateLimiterService } from './rate-limiter.service';
import { JitterService } from './anti-ban/jitter.service';
import { QuietHoursService } from './anti-ban/quiet-hours.service';
import { WorkerTrackerService } from './worker-tracker.service';
import { ConfigService } from '@nestjs/config';
import { SessionService } from '../../session/session.service';
import { BrowserFetchUtil } from '@common/utils/browser-fetch.util';
import { AdminAccount } from '@database/entities/wa-automation/admin-account.entity';

export enum ErrorCategory {
  RATE_LIMITED = 'rate_limited',
  SESSION_EXPIRED = 'session_expired',
  GROUP_NOT_FOUND = 'group_not_found',
  TIMEOUT = 'timeout',
  SEND_FAILED = 'send_failed',
  BOT_DETECTED = 'bot_detected',
  GROUP_FULL = 'group_full',
  UNKNOWN = 'unknown',
}

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  responseTime?: number;
}

export function isMediaMime(mime: string): boolean {
  return (
    mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf'
  );
}

@Injectable()
export class AutomationService {
  private readonly logger = new Logger('AutomationService');
  private readonly maxRetries: number;
  private readonly FAILED_RETRY_TTL_MS = 3_600_000;
  private readonly rateLimitRetryDelay: number;
  private readonly isLocal: boolean;

  /**
   * Disk-backed cache of generated link-preview thumbnails keyed by article URL.
   * Hostinger WAF rate-limits the Render IP when the same Devanagari image is
   * re-fetched on every broadcast (429 on raw + browser fetch). Persisting to
   * disk means each article's og:image is fetched at most once, even across
   * process restarts.
   */
  private readonly previewThumbnailCache = new Map<string, { base64?: string; at: number }>();
  private readonly PREVIEW_THUMBNAIL_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  private readonly previewThumbnailCacheFile = path.join(
    process.cwd(),
    'data',
    'link-preview-thumbnails.json',
  );

  private loadPreviewThumbnailCache(): void {
    try {
      if (fs.existsSync(this.previewThumbnailCacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.previewThumbnailCacheFile, 'utf-8')) as Record<
          string,
          { base64?: string; at: number }
        >;
        for (const [k, v] of Object.entries(parsed)) {
          if (v && v.base64 && Date.now() - v.at < this.PREVIEW_THUMBNAIL_TTL_MS) {
            this.previewThumbnailCache.set(k, v);
          }
        }
        this.logger.log(`[LinkPreview] Loaded ${this.previewThumbnailCache.size} cached thumbnails from disk`);
      }
    } catch (err) {
      this.logger.warn(`[LinkPreview] Could not load thumbnail cache: ${(err as Error).message}`);
    }
  }

  private persistPreviewThumbnailCache(): void {
    try {
      const dir = path.dirname(this.previewThumbnailCacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: Record<string, { base64?: string; at: number }> = {};
      for (const [k, v] of this.previewThumbnailCache.entries()) {
        if (Date.now() - v.at < this.PREVIEW_THUMBNAIL_TTL_MS) payload[k] = v;
      }
      fs.writeFileSync(this.previewThumbnailCacheFile, JSON.stringify(payload), 'utf-8');
    } catch (err) {
      this.logger.warn(`[LinkPreview] Could not persist thumbnail cache: ${(err as Error).message}`);
    }
  }

  constructor(
    private readonly engineFactory: EngineFactory,
    private readonly rateLimiter: RateLimiterService,
    private readonly jitterService: JitterService,
    private readonly quietHours: QuietHoursService,
    private readonly sessionService: SessionService,
    configService: ConfigService,
    @InjectRepository(AdminAccount, 'data')
    private readonly adminRepo: Repository<AdminAccount>,
  ) {
    this.maxRetries = configService.get<number>('automation.maxRetryAttempts', 3);
    this.rateLimitRetryDelay = configService.get<number>('automation.rateLimitRetryDelay', 3600);
    this.isLocal = configService.get<boolean>('isLocal', false);
    this.loadPreviewThumbnailCache();
  }

  /**
   * Deliver a message to a WhatsApp group via the engine.
   * Called directly — no HTTP round-trip.
   */
  async deliverMessage(
    sessionId: string,
    chatId: string,
    text: string,
    adminId: number,
    workerId: string,
    imageUrls: string[] = [],
  ): Promise<DeliveryResult> {
    const startTime = Date.now();

    // 1. Check quiet hours (reads from DB settings with timezone awareness).
    //    Skipped in local mode — quiet hours exist to protect WhatsApp numbers
    //    from night-time cloud-IP suspicion; a residential IP runs freely.
    if (!this.isLocal) {
      const inQuietHours = await this.quietHours.isQuietHours();
      if (inQuietHours) {
        const mins = await this.quietHours.minutesUntilEnd();
        return {
          success: false,
          errorCategory: ErrorCategory.RATE_LIMITED,
          errorMessage: `Quiet hours (${mins}min until end)`,
        };
      }
    }

    // 2. Check rate limits
    const rateCheck = this.rateLimiter.check(adminId);
    if (!rateCheck.allowed) {
      return {
        success: false,
        errorCategory: ErrorCategory.RATE_LIMITED,
        errorMessage: rateCheck.reason,
      };
    }

    // 3. Attempt delivery — use the existing running engine from SessionService
    //    rather than creating a new one via engineFactory (which returns a fresh
    //    uninitialized adapter).
    try {
      const engine = this.sessionService.getEngine(sessionId);
      if (!engine) {
        return {
          success: false,
          errorCategory: ErrorCategory.SESSION_EXPIRED,
          errorMessage: `Session ${sessionId} is not running`,
        };
      }

      let result: any;

      if (imageUrls.length > 0) {
        // Send first media with text as caption, then remaining media standalone.
        // WhatsApp auto-groups quick-successive images into a gallery on the receiver.
        let isFirst = true;
        for (const imageUrl of imageUrls) {
          let mediaData = imageUrl;
          let mediaMime = 'image/jpeg';
          let mediaFilename = `attachment.${this.mimeToExt(mediaMime)}`;
          if (imageUrl.startsWith('data:')) {
            const commaIdx = imageUrl.indexOf(',');
            if (commaIdx !== -1) {
              const header = imageUrl.substring(5, commaIdx);
              mediaData = imageUrl.substring(commaIdx + 1);
              const semiIdx = header.indexOf(';');
              if (semiIdx !== -1) {
                mediaMime = header.substring(0, semiIdx);
                mediaFilename = `attachment.${this.mimeToExt(mediaMime)}`;
              }
            }
          }

          const opts: any = { mimetype: mediaMime, data: mediaData, filename: mediaFilename };
          if (isFirst && text) {
            opts.caption = text;
            isFirst = false;
          }

          const mimeType = mediaMime.toLowerCase();
          if (mimeType.startsWith('image/')) {
            result = await engine.sendImageMessage(chatId, opts);
          } else if (mimeType.startsWith('video/')) {
            result = await engine.sendVideoMessage(chatId, opts);
          } else if (mimeType.startsWith('audio/')) {
            result = await engine.sendAudioMessage(chatId, opts);
          } else {
            result = await engine.sendDocumentMessage(chatId, opts);
          }

          // Brief pause to avoid rate issues between media (skipped in local mode)
          if (!this.isLocal) {
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      } else {
        result = await engine.sendTextMessage(chatId, text, { linkPreview: true });
      }

      // 4. Increment rate limit counters and admin stats on success
      this.rateLimiter.increment(adminId);
      await this.adminRepo.increment({ id: adminId }, 'totalSent', 1);
      await this.adminRepo.update(adminId, { lastSentAt: new Date() });

      return {
        success: true,
        messageId: result?.id,
        responseTime: Date.now() - startTime,
      };
    } catch (err) {
      const errorMessage = (err as Error).message;
      const category = this.classifyError(errorMessage);
      await this.adminRepo.increment({ id: adminId }, 'totalFailed', 1);

      return {
        success: false,
        errorCategory: category,
        errorMessage,
        responseTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Schedule a message delivery with jitter delay.
   * Returns a promise that resolves after the delay + delivery.
   */
  async scheduleDelayedDelivery(
    sessionId: string,
    chatId: string,
    text: string,
    adminId: number,
    workerId: string,
    batchIndex: number,
    imageUrls: string[] = [],
  ): Promise<DeliveryResult> {
    const delay = this.jitterService.calculateDelay(batchIndex);
    this.logger.debug(`Scheduling delivery to ${chatId} with ${Math.round(delay / 1000)}s jitter`);

    return new Promise(resolve => {
      setTimeout(async () => {
        const result = await this.deliverMessage(sessionId, chatId, text, adminId, workerId, imageUrls);
        resolve(result);
      }, delay);
    });
  }

  /**
   * Fetch OG metadata for the URL in `text`, then inject it into the WA page
   * context by monkey-patching WAWebLinkPreviewChatAction.getLinkPreview.
   *
   * Why: In headless Puppeteer on Render, getLinkPreview fails to crawl the
   * target URL (WAF/bot-detection blocks the headless request), so it returns
   * null and no preview is attached. We bypass this by fetching OG metadata
   * ourselves (via BrowserFetchUtil which already has a WAF bypass) and then
   * patching getLinkPreview to return our data in the exact format WWebJS
   * expects: { data: { canonicalUrl, matchedText, title, description, jpegThumbnail } }.
   */
  async preWarmLinkPreview(sessionId: string, text: string): Promise<void> {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    const engine = this.sessionService.getEngine(sessionId);
    if (!engine || !engine.warmUpLinkPreview) return;

    try {
      this.logger.log(`[LinkPreview] Stage 1/5 fetch article html: ${url}`);
      const html = await BrowserFetchUtil.fetchWithFallback(url, 20000);
      this.logger.log(`[LinkPreview] Stage 1/5 done — html length: ${html.length}`);

      const $ = cheerio.load(html);
      const title =
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        $('title').first().text().trim() ||
        '';
      const description =
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        '';
      this.logger.log(`[LinkPreview] Stage 2/5 og parsed — title: "${title.slice(0, 60)}" | description len: ${description.length}`);

      let jpegThumbnailBase64: string | undefined;
      const imageUrl =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content');
      let absImageUrl: string | undefined;
      if (imageUrl) {
        absImageUrl = new URL(imageUrl, url).href;
        this.logger.log(`[LinkPreview] Stage 3/5 og:image raw: ${imageUrl} | encoded: ${absImageUrl}`);

        // Rewrite the og:image in the HTML we serve to WhatsApp's native
        // crawler to the percent-encoded ASCII URL. The site serves raw
        // Unicode (e.g. Devanagari) filenames in og:image; WA's server-side
        // crawl fetches the raw URL and fails, so native returns no thumbnail
        // and we fall into the synthetic fallback. With an encoded URL the
        // native crawl succeeds exactly like English-filename articles — no
        // fallback needed.
        if (imageUrl !== absImageUrl) {
          $('meta[property="og:image"]').attr('content', absImageUrl);
          $('meta[name="twitter:image"]').attr('content', absImageUrl);
        }
        
        // Generate a SMALL inline thumbnail that embeds directly in the message.
        // WhatsApp's ExtendedTextMessage has tight inline data limits (~10KB max
        // for the base64 JPEG). However, if the image is too small (e.g. 200px), 
        // WhatsApp Web rendering will force it to be a compact square regardless 
        // of thumbnailWidth/Height. 600px is a good balance between size and quality.
        // Retry on transient WAF/network failures so a fallback registered
        // without a thumbnail never leaves a group with a text-only preview.
        // Cache per-article so we don't re-hit the WAF on every broadcast.
        const cached = this.previewThumbnailCache.get(url);
        if (cached && Date.now() - cached.at < this.PREVIEW_THUMBNAIL_TTL_MS) {
          jpegThumbnailBase64 = cached.base64;
          this.logger.log(`[LinkPreview] Stage 3/5 thumbnail cache hit for ${url}`);
        }
        if (!jpegThumbnailBase64) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            jpegThumbnailBase64 = await BrowserFetchUtil.fetchAndResizeImageBase64(absImageUrl, 600);
            if (jpegThumbnailBase64) break;
            this.logger.warn(`[LinkPreview] Stage 3/5 thumbnail attempt ${attempt} failed — retrying...`);
            await new Promise(r => setTimeout(r, 3000));
          }
          this.previewThumbnailCache.set(url, { base64: jpegThumbnailBase64, at: Date.now() });
        }
        this.logger.log(`[LinkPreview] Stage 3/5 thumbnail result: ${jpegThumbnailBase64 ? `OK (${jpegThumbnailBase64.length} b64 chars, ~${Math.round((jpegThumbnailBase64.length * 0.75) / 1024)} KB)` : 'FAILED/undefined — fallback image will be missing!'}`);
      } else {
        this.logger.warn(`[LinkPreview] Stage 3/5 NO og:image or twitter:image found — no thumbnail will be available`);
      }

      // Get image dimensions from the og:image for proper display
      const imageWidth = $('meta[property="og:image:width"]').attr('content') || '800';
      const imageHeight = $('meta[property="og:image:height"]').attr('content') || '400';
      this.logger.log(`[LinkPreview] Stage 4/5 warmUpLinkPreview — img dims: ${imageWidth}x${imageHeight} | jpegThumbnail: ${jpegThumbnailBase64 ? 'present' : 'absent'}`);

      await engine.warmUpLinkPreview(url, { 
        title, 
        description, 
        // Serve the REWRITTEN HTML (og:image percent-encoded to ASCII) so WA's
        // native crawler fetches a URL it can actually request — the same
        // behavior as English-filename articles.
        pageHtml: $.html(),
        imageUrl: absImageUrl,
        jpegThumbnailBase64,
        thumbnailWidth: parseInt(imageWidth, 10) || 800,
        thumbnailHeight: parseInt(imageHeight, 10) || 400
      });
      this.logger.log(`[LinkPreview] Stage 5/5 injected for: ${url} | title: "${title.slice(0, 60)}"`);
    } catch (err) {
      this.logger.warn(`[LinkPreview] preWarmLinkPreview FAILED for ${url}: ${(err as Error).message}`);
    }
  }


  /**
   * Edit a previously sent WhatsApp message in a given group.
   */
  async editMessage(sessionId: string, chatId: string, messageId: string, newText: string): Promise<DeliveryResult> {
    const startTime = Date.now();
    try {
      const engine = this.sessionService.getEngine(sessionId);
      if (!engine) {
        return {
          success: false,
          errorCategory: ErrorCategory.SESSION_EXPIRED,
          errorMessage: `Session ${sessionId} is not running`,
        };
      }
      await engine.editMessage(chatId, messageId, newText);
      return { success: true, responseTime: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        errorCategory: this.classifyError((err as Error).message),
        errorMessage: (err as Error).message,
        responseTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Delete a previously sent WhatsApp message in a given group.
   */
  async deleteMessage(sessionId: string, chatId: string, messageId: string): Promise<DeliveryResult> {
    const startTime = Date.now();
    try {
      const engine = this.sessionService.getEngine(sessionId);
      if (!engine) {
        return {
          success: false,
          errorCategory: ErrorCategory.SESSION_EXPIRED,
          errorMessage: `Session ${sessionId} is not running`,
        };
      }
      await engine.deleteMessage(chatId, messageId, true);
      return { success: true, responseTime: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        errorCategory: this.classifyError((err as Error).message),
        errorMessage: (err as Error).message,
        responseTime: Date.now() - startTime,
      };
    }
  }

  private classifyError(message: string): ErrorCategory {
    const lower = message.toLowerCase();
    if (lower.includes('rate') || lower.includes('limit') || lower.includes('too many')) {
      return ErrorCategory.RATE_LIMITED;
    }
    if (lower.includes('session') || lower.includes('disconnected') || lower.includes('qr') || lower.includes('auth')) {
      return ErrorCategory.SESSION_EXPIRED;
    }
    if (lower.includes('group') || lower.includes('chat') || lower.includes('not found')) {
      return ErrorCategory.GROUP_NOT_FOUND;
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return ErrorCategory.TIMEOUT;
    }
    if (lower.includes('ban') || lower.includes('blocked') || lower.includes('spam')) {
      return ErrorCategory.BOT_DETECTED;
    }
    if (lower.includes('full') || lower.includes('capacity')) {
      return ErrorCategory.GROUP_FULL;
    }
    if (lower.includes('send') || lower.includes('failed') || lower.includes('error')) {
      return ErrorCategory.SEND_FAILED;
    }
    return ErrorCategory.UNKNOWN;
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'text/plain': 'txt',
    };
    return map[mime] || 'bin';
  }
}
