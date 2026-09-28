import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Ad } from './schema.js';

export type SortKey = 'price' | 'date' | 'views';

export interface Failure {
  url: string;
  error: string;
  at: string;
}

/** price: ascending by EUR value, non-numeric last. date/views: newest/most first. */
export function sortAds(ads: Ad[], key: SortKey): Ad[] {
  const byNullableNum = (a: number | null, b: number | null, dir: 1 | -1) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * dir;
  };
  const cmp: Record<SortKey, (a: Ad, b: Ad) => number> = {
    price: (a, b) => byNullableNum(a.price.amountEur ?? a.price.amount, b.price.amountEur ?? b.price.amount, 1),
    date: (a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''),
    views: (a, b) => byNullableNum(a.viewCount, b.viewCount, -1),
  };
  return [...ads].sort((a, b) => cmp[key](a, b) || a.id - b.id);
}

export async function writeJson(dir: string, ads: Ad[]) {
  await writeFile(path.join(dir, 'ads.json'), JSON.stringify(ads, null, 2));
}

export async function writeErrors(dir: string, failures: Failure[], notes: string[] = []) {
  const lines = [...notes, ...failures.map((f) => `${f.at}\t${f.url}\t${f.error}`)];
  await writeFile(path.join(dir, 'errors.log'), lines.join('\n') + (lines.length ? '\n' : ''));
}

const LINK_FONT = { color: { argb: 'FF0563C1' }, underline: true } as const;

export async function writeXlsx(dir: string, ads: Ad[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'kupujemprodajem-scraper';
  wb.created = new Date();

  // --- Sheet 1: one row per ad ---
  const ws = wb.addWorksheet('Ads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Naslov', key: 'title', width: 45 },
    { header: 'Cena', key: 'price', width: 12, style: { numFmt: '#,##0.##' } },
    { header: 'Valuta', key: 'currency', width: 8 },
    { header: 'Cena (EUR)', key: 'priceEur', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Cena (tekst)', key: 'priceLabel', width: 14 },
    { header: 'Lokacija', key: 'location', width: 20 },
    { header: 'Prodavac', key: 'seller', width: 22 },
    { header: 'Ocene +', key: 'reviewsPos', width: 9 },
    { header: 'Ocene −', key: 'reviewsNeg', width: 9 },
    { header: 'Datum', key: 'date', width: 19 },
    { header: 'URL', key: 'url', width: 14 },
    { header: 'Stanje', key: 'condition', width: 22 },
    { header: 'Kategorija', key: 'category', width: 30 },
    { header: 'Pregledi', key: 'views', width: 10 },
    { header: 'Omiljeno', key: 'favorites', width: 10 },
    { header: 'ID oglasa', key: 'id', width: 11 },
    { header: 'Tip', key: 'adType', width: 7 },
    { header: 'Promovisan', key: 'promoted', width: 11 },
    { header: 'Član od', key: 'memberSince', width: 12 },
    { header: 'Aktivnih oglasa', key: 'sellerAds', width: 10 },
    { header: 'Bedževi', key: 'badges', width: 30 },
    { header: 'Profil prodavca', key: 'sellerUrl', width: 14 },
    { header: 'Slike', key: 'imageCount', width: 7 },
    { header: 'Atributi', key: 'attributes', width: 50 },
    { header: 'Opis', key: 'description', width: 80 },
  ];

  for (const ad of ads) {
    const row = ws.addRow({
      title: ad.title,
      price: ad.price.amount,
      currency: ad.price.currency,
      priceEur: ad.price.amountEur,
      priceLabel: ad.price.label,
      location: ad.location,
      seller: ad.seller.name,
      reviewsPos: ad.seller.reviewsPositive,
      reviewsNeg: ad.seller.reviewsNegative,
      date: ad.postedAt,
      url: { text: 'Otvori oglas', hyperlink: ad.url },
      condition: ad.condition,
      category: ad.category.path,
      views: ad.viewCount,
      favorites: ad.favoriteCount,
      id: ad.id,
      adType: ad.adType,
      promoted: ad.promoted ? 'da' : '',
      memberSince: ad.seller.memberSinceDate ?? ad.seller.memberSince,
      sellerAds: ad.seller.activeAds,
      badges: ad.seller.badges.join(', '),
      sellerUrl: ad.seller.profileUrl ? { text: 'Profil', hyperlink: ad.seller.profileUrl } : null,
      imageCount: ad.images.length,
      attributes: Object.entries(ad.attributes).map(([k, v]) => `${k}: ${v}`).join('\n'),
      description: ad.description,
    });
    row.getCell('url').font = LINK_FONT;
    if (ad.seller.profileUrl) row.getCell('sellerUrl').font = LINK_FONT;
    row.getCell('attributes').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('description').alignment = { wrapText: true, vertical: 'top' };
    row.alignment = { ...row.alignment, vertical: 'top' };
  }
  styleHeader(ws);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };

  // --- Sheet 2: grouped by seller (summary row + collapsible ad rows) ---
  const ss = wb.addWorksheet('Sellers', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { outlineLevelRow: 1 },
  });
  // Group summary sits above its ad rows (exceljs lacks a typed setter for this).
  (ss as unknown as { properties: { outlineProperties?: object } }).properties.outlineProperties = { summaryBelow: false };
  ss.columns = [
    { header: 'Prodavac / oglas', key: 'name', width: 50 },
    { header: 'Oglasa u pretrazi', key: 'count', width: 12 },
    { header: 'Aktivnih ukupno', key: 'active', width: 12 },
    { header: 'Ocene +', key: 'pos', width: 9 },
    { header: 'Ocene −', key: 'neg', width: 9 },
    { header: 'Član od', key: 'since', width: 12 },
    { header: 'Lokacija', key: 'location', width: 20 },
    { header: 'Bedževi', key: 'badges', width: 30 },
    { header: 'Link', key: 'link', width: 14 },
    { header: 'Cena', key: 'price', width: 14 },
  ];

  const groups = new Map<string, Ad[]>();
  for (const ad of ads) {
    const key = ad.seller.id !== null ? `id:${ad.seller.id}` : `name:${ad.seller.name}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(ad);
  }
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length || a[0]!.seller.name.localeCompare(b[0]!.seller.name));
  for (const sellerAds of sorted) {
    const s = sellerAds[0]!.seller;
    const head = ss.addRow({
      name: s.name || '(nepoznat)',
      count: sellerAds.length,
      active: s.activeAds,
      pos: s.reviewsPositive,
      neg: s.reviewsNegative,
      since: s.memberSinceDate ?? s.memberSince,
      location: s.location,
      badges: s.badges.join(', '),
      link: s.profileUrl ? { text: 'Profil', hyperlink: s.profileUrl } : null,
    });
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    if (s.profileUrl) head.getCell('link').font = { ...LINK_FONT, bold: true };
    for (const ad of sellerAds) {
      const r = ss.addRow({
        name: `    ${ad.title}`,
        link: { text: 'Otvori oglas', hyperlink: ad.url },
        price: ad.price.label,
      });
      r.getCell('link').font = LINK_FONT;
      r.outlineLevel = 1;
    }
  }
  styleHeader(ss);

  await wb.xlsx.writeFile(path.join(dir, 'ads.xlsx'));
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
}
