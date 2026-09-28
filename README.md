# KupujemProdajem scraper

Polite CLI scraper for [kupujemprodajem.com](https://www.kupujemprodajem.com) search results.
Give it a search URL with your filters already applied; it walks every result page,
visits each ad, and writes JSON + Excel.

## How it works

KP is a Next.js app that server-renders its whole Redux store into
`<script id="__NEXT_DATA__">`. Both search pages (`search.adsIds/byId/pages/total`)
and ad pages (`ad.byId[id]`: price, attributes, photos, seller…) carry complete
structured JSON, so the scraper uses plain HTTP (`undici`) and no browser.
The only DOM lookup is the seller's public "Svi oglasi" link, which gives the
seller's total active-ad count (one extra request per unique seller, cached).

## Install & run

Node 20.18+.

```bash
npm install

npx tsx src/scrape.ts "https://www.kupujemprodajem.com/pretraga?keywords=iphone%2013&priceTo=300&currency=eur" \
  --max-pages 5 --sort price --out ./output
```

Scrape one ad and print the parsed object (handy for checking fields):

```bash
npx tsx src/scrape.ts "https://www.kupujemprodajem.com/automobili/opel/opel-meriva-1-6-benzin/oglas/195073267"
```

| Option | Default | |
|---|---|---|
| `--max-pages N` | all | stop after N result pages |
| `--limit N` | all | scrape at most N ads |
| `--sort price\|date\|views` | `price` | price ascending (EUR-normalized, no-price last); date newest first; views most first |
| `--out DIR` | `./output` | output root; cache is in `DIR/.cache` |
| `--skip-sellers` | off | skip seller pages (no "active ads" count) |
| `--delay MIN-MAX` | `1.5-4` | seconds between requests (MIN ≥ 1.5) |
| `--refresh-search` | off | re-fetch result pages even if cached |

Behind a proxy, `HTTPS_PROXY` / `NO_PROXY` are honored.

## Output

`<out>/<timestamp>/`:

- `ads.json` — full data, one object per ad (schema: `src/schema.ts`)
- `ads.xlsx` — sheet **Ads** (key columns first, clickable URL, wrapped description) and
  sheet **Sellers** (one bold row per seller with ad count, collapsible ad rows with links)
- `errors.log` — `timestamp  url  error`, plus a `# STOPPED:` line if the run was halted

## Politeness & safety

- Strictly sequential; random 1.5–4 s pause between requests; realistic browser User-Agent.
- 429 / 5xx / network errors: exponential backoff (5 s, 10 s, 20 s, or `Retry-After`), max 3 retries.
- No login, no "show phone number", no captcha solving. A 403, captcha, anti-bot or KP
  soft-block page stops the run immediately; results collected so far are still written
  and the reason is printed (exit code 2).
- Ctrl+C stops after the current request and writes partial results.

## If KP blocks you

KP rate-limits per IP; the default pace got an anti-bot check after ~140 requests.
The scraper stops, writes what it has, and the cache keeps it. Wait a few hours, then
rerun the same command slower, e.g. `--delay 6-12 --skip-sellers`. It resumes where it
stopped. Don't try to get around the block (VPN/IP rotation, captcha solving).

## Resuming

Result pages are cached for 24h in `<out>/.cache/search/`, so a rerun doesn't re-walk them.
Every fetched ad is cached as JSON in `<out>/.cache/ads/<adId>.json` (seller counts in
`.cache/sellers/`). Rerunning with the same `--out` skips cached ads; failed ads aren't
cached, so they're retried. Delete `.cache` to force a fresh scrape.

## Field notes

- `price.amount` is `null` for "Dogovor", "Kontakt", "Kupujem" etc.; `price.label` keeps KP's text.
  `price.amountEur` converts RSD using KP's own middle rate from the page.
- `postedAt` is KP's `postedRaw` — the posting or last-renewal time (`isRenewed` tells which).
- `seller.activeAds` is `null` when the seller hides their ad list.

## Code

```
src/fetch.ts        HTTP + retry + delay + disk cache, BlockedError
src/nextData.ts     __NEXT_DATA__ extraction + block/captcha detection
src/parseSearch.ts  result page → ad IDs/URLs, pagination info
src/parseAd.ts      ad page → raw payload (cached) → validated Ad
src/schema.ts       Zod schema for Ad
src/export.ts       sorting, ads.json, ads.xlsx, errors.log
src/scrape.ts       CLI
```

`npm run typecheck` runs `tsc --noEmit`.
