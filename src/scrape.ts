#!/usr/bin/env -S npx tsx
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { BlockedError, Fetcher } from './fetch.js';
import { parseSearch, searchPageUrl } from './parseSearch.js';
import { extractRawAd, parseAd, parseSellerPage, type RawAdPayload, type SellerExtra } from './parseAd.js';
import { sortAds, writeErrors, writeJson, writeXlsx, type Failure, type SortKey } from './export.js';
import type { Ad } from './schema.js';

const USAGE = `Usage:
  npx tsx src/scrape.ts "<KP search URL>" [options]
  npx tsx src/scrape.ts "<KP ad URL>"            # scrape one ad and print it

Options:
  --max-pages N     stop after N result pages (default: all)
  --limit N         scrape at most N ads (default: all)
  --sort KEY        price | date | views (default: price, ascending; no-price last)
  --out DIR         output root (default: ./output); cache lives in DIR/.cache
  --skip-sellers    don't visit seller pages (no "active ads" count)
  -h, --help`;

interface Options {
  url: string;
  maxPages: number;
  limit: number;
  sort: SortKey;
  out: string;
  skipSellers: boolean;
}

function parseCli(): Options {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'max-pages': { type: 'string' },
      limit: { type: 'string' },
      sort: { type: 'string', default: 'price' },
      out: { type: 'string', default: './output' },
      'skip-sellers': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const fail = (msg: string): never => {
    console.error(`${msg}\n\n${USAGE}`);
    process.exit(1);
  };
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const url = positionals[0] ?? fail('Missing search URL.');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    fail(`Invalid URL: ${url}`);
  }
  if (!/(^|\.)kupujemprodajem\.com$/.test(host)) fail('URL must be on kupujemprodajem.com');
  const posInt = (name: string, v: string | undefined) => {
    if (v === undefined) return Infinity;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fail(`--${name} must be a positive integer`);
  };
  const sort = values.sort as SortKey;
  if (!['price', 'date', 'views'].includes(sort)) fail('--sort must be price, date or views');
  return {
    url,
    maxPages: posInt('max-pages', values['max-pages']),
    limit: posInt('limit', values.limit),
    sort,
    out: values.out!,
    skipSellers: values['skip-sellers']!,
  };
}

const AD_URL_RE = /\/oglas\/(\d+)/;
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-');
const errMsg = (e: unknown) =>
  e instanceof ZodError ? `validation: ${e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` : e instanceof Error ? e.message : String(e);

async function main() {
  const opts = parseCli();
  const started = Date.now();
  const outDir = path.resolve(opts.out, stamp());
  const fetcher = new Fetcher({ cacheDir: path.resolve(opts.out, '.cache') });
  const failures: Failure[] = [];
  const fail = (url: string, e: unknown) => {
    failures.push({ url, error: errMsg(e), at: new Date().toISOString() });
    console.error(`  ✗ ${url}\n    ${errMsg(e)}`);
  };

  let stopReason: string | null = null;
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    stopReason = 'Interrupted by user (Ctrl+C) — writing partial results. Press Ctrl+C again to quit immediately.';
    console.warn(`\n${stopReason}`);
  });

  // 1) Collect ad URLs from all result pages (or take the single ad URL).
  const queue = new Map<number, string>();
  let pagesScanned = 0;
  let searchTotal: number | null = null;
  const singleAd = AD_URL_RE.exec(new URL(opts.url).pathname);

  if (singleAd) {
    queue.set(Number(singleAd[1]), opts.url);
  } else {
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, opts.maxPages) && !stopReason; page++) {
      const url = searchPageUrl(opts.url, page);
      try {
        const { html, finalUrl } = await fetcher.getHtml(url);
        const res = parseSearch(html, finalUrl);
        pagesScanned++;
        totalPages = res.pages || totalPages;
        searchTotal ??= res.total;
        const before = queue.size;
        for (const hit of res.hits) if (!queue.has(hit.id)) queue.set(hit.id, hit.url);
        console.log(`Page ${page}/${totalPages}: ${res.hits.length} ads (${queue.size - before} new, ${queue.size} unique)`);
        if (res.hits.length === 0) break;
      } catch (e) {
        if (e instanceof BlockedError) {
          stopReason = `BLOCKED on ${e.url}: ${e.message}`;
          break;
        }
        fail(url, e);
        if (page === 1) stopReason = 'First search page failed — nothing to scrape.';
      }
    }
  }

  // 2) Visit each ad (cache first), then its seller page once per seller.
  const ads: Ad[] = [];
  const sellerCache = new Map<number, SellerExtra>();
  const entries = [...queue.entries()].slice(0, opts.limit);
  let fromCache = 0;

  for (const [i, [id, url]] of entries.entries()) {
    if (stopReason) break;
    const tag = `[${i + 1}/${entries.length}] ${id}`;
    try {
      let raw = await fetcher.readCache<RawAdPayload>('ads', id);
      if (raw) {
        fromCache++;
      } else {
        const { html, finalUrl } = await fetcher.getHtml(url);
        raw = extractRawAd(html, finalUrl, id);
        await fetcher.writeCache('ads', id, raw);
      }

      let extra: SellerExtra | undefined;
      const sellerId = Number(raw.ad?.user?.userId || raw.ad?.userId);
      if (!opts.skipSellers && raw.sellerProfilePath && sellerId) {
        extra = sellerCache.get(sellerId) ?? (await fetcher.readCache<SellerExtra>('sellers', sellerId));
        if (!extra) {
          const sellerUrl = new URL(raw.sellerProfilePath, url).toString();
          try {
            const { html, finalUrl } = await fetcher.getHtml(sellerUrl);
            extra = parseSellerPage(html, finalUrl);
            await fetcher.writeCache('sellers', sellerId, extra);
          } catch (e) {
            if (e instanceof BlockedError) throw e;
            fail(sellerUrl, e); // seller info is secondary; keep the ad
          }
        }
        if (extra) sellerCache.set(sellerId, extra);
      }

      const ad = parseAd(raw, extra);
      ads.push(ad);
      console.log(`${tag} ✓ ${ad.price.label.padEnd(12)} ${ad.title.slice(0, 60)}`);
    } catch (e) {
      if (e instanceof BlockedError) {
        stopReason = `BLOCKED on ${e.url}: ${e.message}`;
        break;
      }
      fail(url, e);
    }
  }

  // 3) Export.
  await mkdir(outDir, { recursive: true });
  const sorted = sortAds(ads, opts.sort);
  await writeJson(outDir, sorted);
  await writeXlsx(outDir, sorted);
  await writeErrors(outDir, failures, stopReason ? [`# STOPPED: ${stopReason}`] : []);

  if (singleAd && sorted[0]) console.log('\n' + JSON.stringify(sorted[0], null, 2));

  const secs = (Date.now() - started) / 1000;
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`;
  console.log(`
──────── Summary ────────
Pages scanned:  ${pagesScanned}${searchTotal !== null ? ` (KP reports ${searchTotal} results)` : ''}
Ads found:      ${queue.size} unique${entries.length < queue.size ? ` (limited to ${entries.length})` : ''}
Ads scraped:    ${ads.length} (${fromCache} from cache)
Failures:       ${failures.length}
HTTP requests:  ${fetcher.requestCount}
Elapsed:        ${elapsed}
Output:         ${outDir}`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  ${f.url}\n    ${f.error}`);
  }
  if (stopReason) {
    console.error(`\n⚠ ${stopReason}`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
