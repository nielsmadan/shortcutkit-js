import { keyCodeForToken, keyToken } from './keys';
import {
  MODIFIER_ORDER,
  type ModifierName,
  type Platform,
  type Shortcut,
  type Step,
  type StepInput,
  modifiers,
  primaryModifier,
} from './shortcut';

export type ShortcutParseErrorReason = 'empty' | 'emptyStep' | 'unknownModifier' | 'unknownKey';

export class ShortcutParseError extends Error {
  readonly reason: ShortcutParseErrorReason;
  readonly token: string;

  constructor(reason: ShortcutParseErrorReason, token: string, text: string) {
    super(`Invalid shortcut "${text}": ${reason}${token ? ` "${token}"` : ''}`);
    this.name = 'ShortcutParseError';
    this.reason = reason;
    this.token = token;
  }
}

const MOUSE_TOKENS: readonly (readonly [string, number])[] = [
  ['left-click', 0],
  ['middle-click', 1],
  ['right-click', 2],
];

function parseModifier(token: string, platform: Platform): ModifierName | undefined {
  if (token === 'mod') return primaryModifier(platform);
  return MODIFIER_ORDER.find((name) => name === token);
}

function parseInput(token: string): StepInput | undefined {
  const code = keyCodeForToken(token);
  if (code) return { type: 'key', code };
  const mouse = MOUSE_TOKENS.find(([name]) => name === token);
  if (mouse) return { type: 'mouse', button: mouse[1] };
  const numbered = /^button([1-9][0-9]?)$/.exec(token);
  if (numbered?.[1]) return { type: 'mouse', button: Number(numbered[1]) - 1 };
  return undefined;
}

function parseStep(token: string, platform: Platform, text: string): Step {
  const parts = token.split('+');
  if (parts.some((part) => part === '')) throw new ShortcutParseError('emptyStep', token, text);
  const last = parts[parts.length - 1] ?? '';
  const names = parts.slice(0, -1).map((part) => {
    const name = parseModifier(part, platform);
    if (!name) throw new ShortcutParseError('unknownModifier', part, text);
    return name;
  });
  const input = parseInput(last);
  if (!input) throw new ShortcutParseError('unknownKey', last, text);
  return { input, modifiers: modifiers(names) };
}

// Steps are space-separated (`mod+k mod+c`); `mod` resolves to meta on macOS and
// ctrl elsewhere. Tokens are lowercase and case-sensitive.
export function parseShortcut(text: string, platform: Platform): Shortcut {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new ShortcutParseError('empty', '', text);
  return { steps: tokens.map((token) => parseStep(token, platform, text)) };
}

export function tryParseShortcut(text: string, platform: Platform): Shortcut | undefined {
  try {
    return parseShortcut(text, platform);
  } catch (error) {
    if (error instanceof ShortcutParseError) return undefined;
    throw error;
  }
}

function formatInput(input: StepInput): string {
  if (input.type === 'mouse') {
    const named = MOUSE_TOKENS.find(([, button]) => button === input.button);
    return named ? named[0] : `button${input.button + 1}`;
  }
  const token = keyToken(input.code);
  if (!token) throw new Error(`Unsupported key code "${input.code}"`);
  return token;
}

export function formatStep(step: Step): string {
  const prefix = MODIFIER_ORDER.filter((name) => step.modifiers[name])
    .map((name) => `${name}+`)
    .join('');
  return prefix + formatInput(step.input);
}

export function formatShortcut(shortcut: Shortcut): string {
  return shortcut.steps.map(formatStep).join(' ');
}
