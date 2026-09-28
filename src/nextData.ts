import { BlockedError } from './fetch.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ReduxState = Record<string, any>;

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/**
 * KP is a Next.js app that server-renders the full Redux store into
 * `__NEXT_DATA__`. Returns `props.initialReduxState`, throwing BlockedError when
 * the page is a captcha / blacklist / soft-block page instead of real content.
 */
export function extractState(html: string, url: string): ReduxState {
  const match = NEXT_DATA_RE.exec(html);
  if (!match) {
    if (/captcha|are you human|access denied|cloudflare/i.test(html)) {
      throw new BlockedError('Captcha or bot-check page returned', url);
    }
    throw new Error('No __NEXT_DATA__ found in page');
  }
  const state = JSON.parse(match[1]!)?.props?.initialReduxState as ReduxState | undefined;
  if (!state) throw new Error('__NEXT_DATA__ has no initialReduxState');

  const meta = state.meta ?? {};
  const antiBot = state.antiBot ?? {};
  if (meta.isBlacklistMode) throw new BlockedError('KP blacklist mode is active for this client', url);
  if (meta.softBlockError?.reason) {
    throw new BlockedError(`KP soft block: ${meta.softBlockError.reason} ${meta.softBlockError.description ?? ''}`.trim(), url);
  }
  if (antiBot.captchaSiteKey || Object.keys(antiBot.antiBotHumanCheck ?? {}).length || Object.keys(antiBot.areYouHumanError ?? {}).length) {
    throw new BlockedError(`KP anti-bot / captcha check triggered: ${JSON.stringify(antiBot).slice(0, 500)}`, url);
  }
  return state;
}
