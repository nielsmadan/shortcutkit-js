// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform, type NavigatorLike } from '../src';

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectPlatform', () => {
  it.each([
    ['macOS', 'mac'],
    ['Windows', 'windows'],
    ['Linux', 'linux'],
    ['Chrome OS', 'linux'],
    ['Android', 'other'],
  ])('maps userAgentData.platform %s to %s', (platform, expected) => {
    expect(detectPlatform({ userAgentData: { platform } })).toBe(expected);
  });

  it.each([
    ['MacIntel', 'mac'],
    ['iPhone', 'mac'],
    ['iPad', 'mac'],
    ['iPod', 'mac'],
    ['Darwin', 'mac'],
    ['Win32', 'windows'],
    ['Linux x86_64', 'linux'],
  ])('maps platform %s to %s', (platform, expected) => {
    expect(detectPlatform({ platform })).toBe(expected);
  });

  it.each([
    [MAC_UA, 'mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'other'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 'linux'],
  ])('maps userAgent %s to %s', (userAgent, expected) => {
    expect(detectPlatform({ userAgent })).toBe(expected);
  });

  it.each<[string, NavigatorLike, string]>([
    [
      'userAgentData wins over platform',
      { userAgentData: { platform: 'Windows' }, platform: 'MacIntel' },
      'windows',
    ],
    [
      'an empty userAgentData.platform falls through to platform',
      { userAgentData: { platform: '' }, platform: 'MacIntel' },
      'mac',
    ],
    ['an empty source is other', {}, 'other'],
  ])('%s', (_name, source, expected) => {
    expect(detectPlatform(source)).toBe(expected);
  });

  it('reads the global navigator by default', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(detectPlatform()).toBe('windows');
  });
});
