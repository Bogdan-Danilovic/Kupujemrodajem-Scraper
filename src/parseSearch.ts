import { extractState } from './nextData.js';

export const KP_ORIGIN = 'https://www.kupujemprodajem.com';

export interface SearchHit {
  id: number;
  url: string;
}

export interface SearchPage {
  page: number;
  pages: number;
  total: number;
  hits: SearchHit[];
}

/** Returns the search URL with `page` set, keeping every filter already in it. */
export function searchPageUrl(searchUrl: string, page: number): string {
  const u = new URL(searchUrl);
  u.searchParams.set('page', String(page));
  return u.toString();
}

export function parseSearch(html: string, url: string): SearchPage {
  const state = extractState(html, url);
  // `search` holds the result list; `adNavigation` mirrors it (used as fallback).
  const s = state.search?.adsIds ? state.search : state.adNavigation;
  if (!s || !Array.isArray(s.adsIds)) throw new Error('Search results not found in page state');

  const hits: SearchHit[] = [];
  for (const rawId of s.adsIds as unknown[]) {
    const id = Number(rawId);
    const adUrl: string | undefined = s.byId?.[String(rawId)]?.adUrl;
    if (!Number.isFinite(id) || !adUrl) continue;
    hits.push({ id, url: new URL(adUrl, KP_ORIGIN).toString() });
  }
  return {
    page: Number(s.page) || 1,
    pages: Number(s.pages) || 0,
    total: Number(s.total) || 0,
    hits,
  };
}
