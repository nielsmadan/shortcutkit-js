import type { Platform } from '@shortcutkit/core';

export interface NavigatorLike {
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly userAgentData?: { readonly platform?: string | undefined } | undefined;
}

export function detectPlatform(source: NavigatorLike = navigator): Platform {
  const text =
    source.userAgentData?.platform || `${source.platform ?? ''} ${source.userAgent ?? ''}`;
  if (/android/i.test(text)) return 'other';
  // "Darwin" contains "win".
  if (/mac|darwin|iphone|ipad|ipod/i.test(text)) return 'mac';
  if (/win/i.test(text)) return 'windows';
  if (/linux|x11|cros|chrome os/i.test(text)) return 'linux';
  return 'other';
}
