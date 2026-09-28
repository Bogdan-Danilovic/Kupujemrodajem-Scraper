import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EnvHttpProxyAgent, fetch, type Dispatcher } from 'undici';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Thrown when KP answers with a block page, captcha or 403. The run must stop. */
export class BlockedError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = 'BlockedError';
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export interface FetcherOptions {
  cacheDir: string;
  minDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
}

export interface FetchResult {
  html: string;
  finalUrl: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

/**
 * Sequential, polite HTTP client: one request at a time, random pause between
 * requests, exponential backoff on 429/5xx/network errors, JSON disk cache.
 */
export class Fetcher {
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly maxRetries: number;
  private readonly dispatcher: Dispatcher;
  private lastRequestEnd = 0;
  requestCount = 0;

  constructor(private readonly opts: FetcherOptions) {
    this.minDelay = opts.minDelayMs ?? 1500;
    this.maxDelay = opts.maxDelayMs ?? 4000;
    this.maxRetries = opts.maxRetries ?? 3;
    // Honors HTTP(S)_PROXY / NO_PROXY when set; direct connection otherwise.
    this.dispatcher = new EnvHttpProxyAgent();
  }

  async getHtml(url: string): Promise<FetchResult> {
    for (let attempt = 0; ; attempt++) {
      await this.politePause();
      let status: number | undefined;
      let retryAfterMs: number | undefined;
      try {
        const res = await fetch(url, {
          dispatcher: this.dispatcher,
          redirect: 'follow',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'sr-RS,sr;q=0.9,en-US;q=0.7,en;q=0.6',
          },
        });
        status = res.status;
        if (res.ok) {
          const html = await res.text();
          return { html, finalUrl: res.url || url };
        }
        await res.body?.cancel();
        if (status === 403) throw new BlockedError('HTTP 403 Forbidden (likely blocked)', url);
        if (status !== 429 && status < 500) throw new HttpError(status, url);
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt >= this.maxRetries) throw new HttpError(status, url);
      } catch (err) {
        if (err instanceof BlockedError || err instanceof HttpError) throw err;
        // Network-level error (reset, timeout, DNS…): retry like a 5xx.
        if (attempt >= this.maxRetries) throw err;
      } finally {
        this.lastRequestEnd = Date.now();
        this.requestCount++;
      }
      const backoff = retryAfterMs ?? 2 ** attempt * 5000 + randInt(0, 1000);
      console.warn(`  ↻ ${status ?? 'network error'} on ${url} — retry ${attempt + 1}/${this.maxRetries} in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }

  private async politePause() {
    if (this.lastRequestEnd === 0) return;
    const wait = randInt(this.minDelay, this.maxDelay) - (Date.now() - this.lastRequestEnd);
    if (wait > 0) await sleep(wait);
  }

  // --- disk cache (JSON, keyed by kind + id) ---

  private cachePath(kind: string, id: string | number) {
    return path.join(this.opts.cacheDir, kind, `${id}.json`);
  }

  async readCache<T>(kind: string, id: string | number): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath(kind, id), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  async writeCache(kind: string, id: string | number, data: unknown): Promise<void> {
    const file = this.cachePath(kind, id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 120_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(date - Date.now(), 0), 120_000);
}
