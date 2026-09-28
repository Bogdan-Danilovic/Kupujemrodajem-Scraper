import * as cheerio from 'cheerio';
import { AdSchema, type Ad, type Seller } from './schema.js';
import { extractState, type ReduxState } from './nextData.js';
import { KP_ORIGIN } from './parseSearch.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What we cache per ad: the raw `ad.byId[id]` object from the page's Redux
 * state plus the few page-level bits we need. Re-parsing from this is free, so
 * parser changes never require re-fetching.
 */
export interface RawAdPayload {
  url: string;
  fetchedAt: string;
  ad: any;
  /** Currency → RSD middle rate, from KP's own converter. */
  rates: Record<string, number>;
  sellerProfilePath: string | null;
}

export interface SellerExtra {
  activeAds: number | null;
}

export function extractRawAd(html: string, url: string, adId: number): RawAdPayload {
  const state: ReduxState = extractState(html, url);
  const byId = state.ad?.byId ?? {};
  const ad = byId[String(adId)] ?? Object.values(byId)[0];
  if (!ad) throw new Error('Ad data not found in page (removed or expired?)');
  if (ad.isAdDeleted) throw new Error('Ad is deleted');

  const rates: Record<string, number> = {};
  for (const [code, r] of Object.entries<any>(state.currencyConverter?.rates ?? {})) {
    if (typeof r?.middle === 'number') rates[code] = r.middle;
  }

  // Seller's public "Svi oglasi" link is rendered only in HTML (slug + userId).
  let sellerProfilePath: string | null = null;
  const userId = ad.user?.userId || ad.userId;
  if (userId) {
    const m = new RegExp(`href="(/[^"/]+/svi-oglasi/${userId}/\\d+)"`).exec(html);
    if (m) sellerProfilePath = m[1]!;
  }

  return { url, fetchedAt: new Date().toISOString(), ad, rates, sellerProfilePath };
}

/** Reads the active-ad count from a seller's public "Svi oglasi" page. */
export function parseSellerPage(html: string, url: string): SellerExtra {
  const state = extractState(html, url);
  const count = state.user?.summary?.userActiveAdCount ?? state.search?.total;
  return { activeAds: toInt(count) };
}

export function parseAd(raw: RawAdPayload, sellerExtra?: SellerExtra): Ad {
  const a = raw.ad;
  const u = a.user ?? {};

  const priceNumber = Number(a.priceNumber);
  const hasPrice = Number.isFinite(priceNumber) && priceNumber > 0;
  const currency = hasPrice ? normalizeCurrency(a.currencyAcronym, a.currency) : null;
  const eurRate = raw.rates.EUR;
  let amountEur: number | null = null;
  if (hasPrice && currency) {
    if (currency === 'EUR') amountEur = priceNumber;
    else if (raw.rates[currency] && eurRate) amountEur = round2((priceNumber * raw.rates[currency]!) / eurRate);
  }

  const categoryPath = [a.categoryName, a.groupName].filter(Boolean).join(' > ');

  const ad = {
    id: Number(a.id),
    title: clean(a.name) ?? clean(a.formattedName) ?? '',
    url: new URL(a.adUrl ?? raw.url, KP_ORIGIN).toString(),
    adType: clean(a.type),
    price: {
      amount: hasPrice ? priceNumber : null,
      currency,
      amountEur,
      label: clean(decode(a.priceDisplay ?? '')) ?? clean(decode(a.priceText ?? '')) ?? '',
      fixed: Boolean(a.isPriceFixed),
      exchange: Boolean(a.isExchange),
    },
    condition: clean(a.condition),
    category: {
      id: toInt(a.categoryId),
      name: clean(a.categoryName),
      groupId: toInt(a.groupId),
      groupName: clean(a.groupName),
      path: categoryPath,
    },
    location: clean(a.location) ?? clean(u.userLocation),
    postedAt: clean(a.postedRaw),
    postedRelative: clean(a.posted),
    isRenewed: Boolean(a.isRenewed),
    validUntil: clean(a.adValidUntil),
    viewCount: toInt(a.viewCount),
    favoriteCount: toInt(a.favoriteCount),
    promoted: Boolean(a.isTop || a.isPriority || a.isHighlighted || a.isTopSearch || a.isStatusGold),
    description: htmlToText(a.description ?? ''),
    attributes: extractAttributes(a),
    images: extractImages(a),
    delivery: {
      immediatelyAvailable: Boolean(a.isImmediateAvailable),
      localPickup: Boolean(a.isLocalPickupAvailable),
      courier: Boolean(a.isCourierDeliveryAvailable),
    },
    seller: extractSeller(a, raw.sellerProfilePath, sellerExtra),
    scrapedAt: raw.fetchedAt,
  };
  return AdSchema.parse(ad);
}

function extractSeller(a: any, profilePath: string | null, extra?: SellerExtra): Seller {
  const u = a.user ?? {};
  const kpIzlogUrl = clean(u.kpizlogUrl) ?? clean(a.kpizlogUrl);
  const kpIzlog = Boolean(a.kpizlog || kpIzlogUrl);
  const traderTitle = clean(decode(u.trader?.title ?? ''));
  const traderDesc = clean(decode(u.trader?.description ?? '').split('\n')[0] ?? '');

  const s: Seller = {
    id: toInt(u.userId) ?? toInt(a.userId),
    name: clean(u.username) ?? clean(a.ownerName) ?? '',
    profileUrl: profilePath ? new URL(profilePath, KP_ORIGIN).toString() : kpIzlogUrl,
    location: clean(u.userLocation),
    memberSince: clean(u.created),
    memberSinceDate: srDateToIso(u.created),
    reviewsPositive: toInt(u.reviewsPositive),
    reviewsNegative: toInt(u.reviewsNegative),
    activeAds: extra?.activeAds ?? (toInt(u.userActiveAdCount) || null),
    declarationType: clean(a.declarationType),
    traderInfo: traderTitle ?? traderDesc,
    responseInfo: clean(u.messageResponseInfo),
    phoneVerified: Boolean(u.isPhoneVerified),
    bankAccountVerified: Boolean(u.hasUserVerifiedBankAccount),
    companyBankAccountVerified: Boolean(u.hasCompanyVerifiedBankAccount),
    kpIzlog,
    kpIzlogUrl,
    badges: [],
  };
  if (s.phoneVerified) s.badges.push('Verifikovan telefon');
  if (s.bankAccountVerified) s.badges.push('Verifikovan bankovni račun');
  if (s.companyBankAccountVerified) s.badges.push('Verifikovan račun firme');
  if (s.kpIzlog) s.badges.push('KP izlog');
  if (s.declarationType === 'company') s.badges.push('Trgovac');
  return s;
}

/** Flattens KP's attribute sections into { "Godište": "2003.", … }. */
function extractAttributes(a: any): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string | null, value: string | null) => {
    if (!key || !value) return;
    if (out[key] === value) return;
    let k = key;
    for (let i = 2; out[k] !== undefined; i++) k = `${key} (${i})`;
    out[k] = value;
  };

  for (const section of Array.isArray(a.adAttributes) ? a.adAttributes : []) {
    // "highlights" repeats a few grid attributes as icons — skip the duplicates.
    if (section?.layout === 'highlights') continue;
    for (const attr of Array.isArray(section?.attributes) ? section.attributes : []) {
      // Decorative bits (silhouette images, unlabeled captions) aren't specs.
      if (attr?.uiControl === 'image') continue;
      const key = clean(attr?.displayName) ?? (attr?.uiControl === 'subtitle' ? clean(section?.displayName) : null);
      const values = (Array.isArray(attr?.values) ? attr.values : [attr?.values])
        .map((v: unknown) => clean(decode(String(v ?? ''))))
        .filter(Boolean);
      put(key, values.join(', ') || null);
    }
  }
  const hasSections = Object.keys(out).length > 0;

  const listText = (v: unknown) =>
    Array.isArray(v)
      ? v.map((x: any) => clean(typeof x === 'string' ? x : x?.name ?? x?.value ?? '')).filter(Boolean).join(', ')
      : null;
  put('Oprema', listText(a.carOptions));
  // Legacy car notes duplicate (and can contradict) the structured sections.
  if (!hasSections) put('Napomene', listText(a.carNotes));
  if (a.isbn) put('ISBN', String(a.isbn));
  put('Autor', clean(a.bookAuthor));
  const rel = a.realEstateLocation ?? {};
  put(
    'Lokacija nekretnine',
    [rel.realEstateLocationCity, rel.realEstateLocationArea, rel.realEstateLocationPlace].map(clean).filter(Boolean).join(', ') || null,
  );
  return out;
}

function extractImages(a: any): string[] {
  const urls = new Set<string>();
  for (const p of Array.isArray(a.photos) ? a.photos : []) {
    const src = p?.fullscreen || p?.original || p?.thumbnail;
    if (isImageUrl(src)) urls.add(src);
  }
  for (const p of Array.isArray(a.photosBig) ? a.photosBig : []) {
    const src = typeof p === 'string' ? p : p?.original ?? p?.fullscreen;
    if (isImageUrl(src)) urls.add(src);
  }
  if (!urls.size && isImageUrl(a.image)) urls.add(a.image);
  return [...urls];
}

const isImageUrl = (s: unknown): s is string =>
  typeof s === 'string' && /^https?:\/\/[^/]+\/.+\.(webp|jpe?g|png|gif|avif)(\?|$)/i.test(s);

// --- helpers ---

/** HTML description → plain text with paragraph and line breaks kept. */
export function htmlToText(html: string): string {
  if (!html.trim()) return '';
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr').each((_, el) => {
    $(el).append('\n');
  });
  $('li').each((_, el) => {
    $(el).prepend('• ');
  });
  return $('#root')
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strips tags and decodes entities ("120&nbsp;&euro;" → "120 €"). */
function decode(s: string): string {
  return /[<&]/.test(s) ? htmlToText(s) : s;
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

/** "1.244" / "12.182" / 21 → integer (KP uses "." as thousands separator). */
function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v !== 'string') return null;
  const digits = v.replace(/[.\s]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  return Math.trunc(Number(digits));
}

function normalizeCurrency(acronym: unknown, symbol: unknown): string | null {
  const a = typeof acronym === 'string' ? acronym.trim().toUpperCase() : '';
  if (a) return a === 'DIN' ? 'RSD' : a;
  const sym = typeof symbol === 'string' ? symbol.trim().toLowerCase() : '';
  if (sym === '€') return 'EUR';
  if (sym === 'din' || sym === 'din.') return 'RSD';
  if (sym === '$') return 'USD';
  return sym ? sym.toUpperCase() : null;
}

/** "14.03.2017." → "2017-03-14" */
function srDateToIso(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(v.trim()) : null;
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
