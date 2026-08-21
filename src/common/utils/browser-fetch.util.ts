import { Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';

export class BrowserFetchUtil {
  private static browser: puppeteer.Browser | null = null;
  private static readonly logger = new Logger('BrowserFetchUtil');

  /**
   * Local mode (residential IP) hits no WAF, so we skip the heavy Puppeteer
   * fallback entirely and keep raw fetches fast. Cloud mode keeps the
   * browser fallback for Hostinger/Cloudflare WAF blocks.
   */
  private static get isLocal(): boolean {
    return process.env.DEPLOYMENT_MODE === 'local' || process.env.NODE_ENV !== 'production';
  }

  private static async getBrowser(): Promise<puppeteer.Browser> {
    if (!this.browser) {
      this.logger.log('Launching shared browser instance for fallback fetch...');
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      });

      // Cleanup on exit
      process.on('exit', () => {
        if (this.browser) {
          this.browser.close().catch(() => {});
        }
      });
    }
    return this.browser;
  }

  static async fetchPageContent(url: string, timeout = 45_000): Promise<string> {
    this.logger.log(`[HtmlFetch] Browser fallback (Hostinger WAF bypass): ${url}`);
    const browser = await this.getBrowser();
    let page: puppeteer.Page | null = null;
    try {
      page = await browser.newPage();
      
      // Mimic a real browser strongly
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      });
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      
      // Optional: wait a moment for CF/WAF challenge to clear if any (not needed locally)
      if (!this.isLocal) {
        await new Promise(r => setTimeout(r, 2000));
      }
      
      const content = await page.content();
      this.logger.log(`[HtmlFetch] Browser fallback OK: ${url} (${content.length} chars)`);
      return content;
    } catch (err) {
      throw new Error(`Browser fetch failed for ${url}: ${(err as Error).message}`);
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  /**
   * Helper method that attempts raw fetch first, and falls back to browser fetch
   * on common WAF blocks or network failures.
   */
  static async fetchWithFallback(url: string, timeout = 30_000): Promise<string> {
    // Local mode: no WAF to bypass — raw fetch only, fail fast.
    if (this.isLocal) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }
      const text = await response.text();
      this.logger.log(`[HtmlFetch] raw fetch OK: ${url} (${text.length} chars)`);
      return text;
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'close',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
        },
      });
      
      if (!response.ok) {
        if (response.status === 403 || response.status === 503 || response.status === 406 || response.status === 429) {
          this.logger.warn(`[HtmlFetch] HTTP ${response.status} (WAF block) from ${url}, attempting browser fallback...`);
          return this.fetchPageContent(url, timeout + 15000);
        }
        this.logger.warn(`[HtmlFetch] HTTP ${response.status} (non-WAF) from ${url} — no browser fallback for this status`);
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }
      const text = await response.text();
      this.logger.log(`[HtmlFetch] raw fetch OK: ${url} (${text.length} chars)`);
      return text;
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.code === 'ECONNRESET' || (err.message && err.message.includes('fetch failed'))) {
        this.logger.warn(`[HtmlFetch] Network error fetching ${url}, attempting browser fallback... (${err.message})`);
        return this.fetchPageContent(url, timeout + 15000);
      }
      throw err;
    }
  }

  static async fetchArrayBufferWithFallback(url: string, timeout = 30_000): Promise<ArrayBuffer> {
    // For images, we can try to fetch them natively. If WAF blocks, we could use page.goto() + page.evaluate()
    // or just page.goto() and then get the response buffer.
    // Local mode: no WAF — raw fetch only, fail fast.
    if (this.isLocal) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }
      const buf = await response.arrayBuffer();
      this.logger.log(`[ImageFetch] raw fetch OK: ${url} (${buf.byteLength} bytes)`);
      return buf;
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (!response.ok) {
        if (response.status === 403 || response.status === 503 || response.status === 406 || response.status === 429) {
          this.logger.warn(`[ImageFetch] HTTP ${response.status} (WAF block) from ${url}, attempting browser fallback...`);
          return this.fetchArrayBufferViaBrowser(url, timeout + 15000);
        }
        this.logger.warn(`[ImageFetch] HTTP ${response.status} (non-WAF) from ${url} — no browser fallback for this status`);
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }
      const buf = await response.arrayBuffer();
      this.logger.log(`[ImageFetch] raw fetch OK: ${url} (${buf.byteLength} bytes)`);
      return buf;
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.code === 'ECONNRESET' || (err.message && err.message.includes('fetch failed'))) {
        this.logger.warn(`[ImageFetch] Network error fetching image ${url}, attempting browser fallback... (${err.message})`);
        return this.fetchArrayBufferViaBrowser(url, timeout + 15000);
      }
      throw err;
    }
  }

  private static async fetchArrayBufferViaBrowser(url: string, timeout = 45_000): Promise<ArrayBuffer> {
    this.logger.log(`[ImageFetch] Browser fallback for image: ${url}`);
    const browser = await this.getBrowser();
    let page: puppeteer.Page | null = null;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout });
      if (!response) {
        throw new Error('No response from browser for image fetch');
      }
      if (!response.ok()) {
        throw new Error(`Browser image fetch HTTP ${response.status()} for ${url}`);
      }
      const buffer = await response.buffer();
      this.logger.log(`[ImageFetch] Browser fallback OK: ${url} (${buffer.length} bytes)`);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    } catch (err) {
      throw new Error(`Browser image fetch failed for ${url}: ${(err as Error).message}`);
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  /**
   * Fetches an image via a blank Puppeteer page (bypassing CSP/CORS constraints),
   * resizes it to a max boundary using Canvas, and returns a JPEG as a base64 string.
   * The image is used for WhatsApp link preview cards — WhatsApp handles its own
   * compression and re-encoding server-side, so the source quality should be reasonable.
   */
  static async fetchAndResizeImageBase64(imageUrl: string, maxSize = 100): Promise<string | undefined> {
    this.logger.log(`[ThumbnailGen] start for: ${imageUrl} (max ${maxSize}px)`);
    const browser = await this.getBrowser();
    let page: puppeteer.Page | null = null;
    try {
      // Attempt 1: Try to fetch the image bytes server-side (with WAF bypass fallback)
      try {
        const buffer = await this.fetchArrayBufferWithFallback(imageUrl);
        const b64 = Buffer.from(buffer).toString('base64');
        const dataUri = `data:image/jpeg;base64,${b64}`;

        page = await browser.newPage();
        page.on('console', msg => {
          this.logger.debug(`[Browser Console] ${msg.text()}`);
        });
        await page.goto('about:blank');
        await page.setContent(
          `<img id="thumb" src="${dataUri}">`,
          { waitUntil: 'load', timeout: 20000 }
        );

        const base64 = await page.evaluate(async (size: number) => {
          try {
            const img = document.getElementById('thumb') as HTMLImageElement;
            if (!img) {
              console.log('[ThumbnailDebug] Image element not found');
              return undefined;
            }

            console.log('[ThumbnailDebug] Before decode - naturalWidth:', img.naturalWidth, 'naturalHeight:', img.naturalHeight, 'complete:', img.complete);
            await img.decode();
            console.log('[ThumbnailDebug] After decode - naturalWidth:', img.naturalWidth, 'naturalHeight:', img.naturalHeight, 'complete:', img.complete);

            const ratio = Math.min(size / img.naturalWidth, size / img.naturalHeight);
            const w = Math.round(img.naturalWidth * ratio);
            const h = Math.round(img.naturalHeight * ratio);
            console.log('[ThumbnailDebug] computed canvas size:', w, 'x', h);

            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
            ctx.drawImage(img, 0, 0, w, h);

            const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.5 });
            const arrBuf = await outBlob.arrayBuffer();
            const bytes = new Uint8Array(arrBuf);

            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            console.log('[ThumbnailDebug] Canvas JPEG output size:', bytes.length, 'bytes');
            return btoa(binary);
          } catch (e: any) {
            console.log('[ThumbnailDebug] Error in evaluate:', e.message || String(e));
            return undefined;
          }
        }, maxSize);

        if (base64) {
          this.logger.log(`[ThumbnailGen] Attempt 1 (server fetch + canvas) OK: ${base64.length} b64 chars`);
          return base64;
        }
        // Fall through to browser-direct load if server-side fetch failed
        this.logger.warn('[ThumbnailGen] Attempt 1 produced undecodable image, trying browser-direct load...');
      } catch (fetchErr) {
        this.logger.warn(`[ThumbnailGen] Attempt 1 (server fetch) failed, trying browser-direct load: ${(fetchErr as Error).message}`);
      }

      // Attempt 2: Load the image URL directly in the browser page rendering pipeline.
      // This bypasses server IP blocks because the browser handles its own HTTP requests
      // with full browser headers, cookies, and JS execution.
      if (!page || page.isClosed()) {
        page = await browser.newPage();
        page.on('console', msg => {
          this.logger.debug(`[Browser Console] ${msg.text()}`);
        });
      }

      // Navigate to a safe page first, then inject the image via JS so we can capture it
      await page.goto('about:blank', { waitUntil: 'load', timeout: 15000 });
      
      const result = await page.evaluate(async (url: string, size: number) => {
        try {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          
          const loadPromise = new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Image load failed'));
          });
          
          img.src = url;
          
          // Wait with timeout
          await Promise.race([
            loadPromise,
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Image load timeout')), 20000))
          ]);
          
          console.log('[ThumbnailDebug] Browser-direct load - naturalWidth:', img.naturalWidth, 'naturalHeight:', img.naturalHeight);
          
          const ratio = Math.min(size / img.naturalWidth, size / img.naturalHeight);
          const w = Math.round(img.naturalWidth * ratio);
          const h = Math.round(img.naturalHeight * ratio);
          console.log('[ThumbnailDebug] Browser-direct canvas size:', w, 'x', h);
          
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(img, 0, 0, w, h);
          
          const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
          const arrBuf = await outBlob.arrayBuffer();
          const bytes = new Uint8Array(arrBuf);
          
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          
          console.log('[ThumbnailDebug] Browser-direct JPEG output size:', bytes.length, 'bytes');
          return btoa(binary);
        } catch (e: any) {
          console.log('[ThumbnailDebug] Browser-direct error:', e.message || String(e));
          return undefined;
        }
      }, imageUrl, maxSize);
      
      if (result) {
        this.logger.log(`[ThumbnailGen] Attempt 2 (browser-direct) OK: ${result.length} b64 chars`);
      } else {
        this.logger.warn(`[ThumbnailGen] Attempt 2 (browser-direct) FAILED for ${imageUrl} — no thumbnail will be available`);
      }
      return result;
    } catch (err) {
      this.logger.warn(`[ThumbnailGen] Thumbnail resize failed for ${imageUrl}: ${(err as Error).message}`);
      return undefined;
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }
}