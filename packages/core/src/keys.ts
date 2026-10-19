const LETTERS = /* @__PURE__ */ 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = /* @__PURE__ */ '0123456789'.split('');
const FUNCTION_KEYS = /* @__PURE__ */ Array.from({ length: 24 }, (_, index) => `F${index + 1}`);

export const BINDABLE_KEY_CODES: readonly string[] = /* @__PURE__ */ (() => [
  ...LETTERS.map((letter) => `Key${letter}`),
  ...DIGITS.map((digit) => `Digit${digit}`),
  'Backquote',
  'Backslash',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Equal',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  'Minus',
  'Period',
  'Quote',
  'Semicolon',
  'Slash',
  'Backspace',
  'ContextMenu',
  'Enter',
  'Space',
  'Tab',
  'Convert',
  'KanaMode',
  'Lang1',
  'Lang2',
  'Lang3',
  'Lang4',
  'Lang5',
  'NonConvert',
  'Delete',
  'End',
  'Help',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  ...DIGITS.map((digit) => `Numpad${digit}`),
  'NumpadAdd',
  'NumpadComma',
  'NumpadDecimal',
  'NumpadDivide',
  'NumpadEnter',
  'NumpadEqual',
  'NumpadMultiply',
  'NumpadSubtract',
  'Escape',
  ...FUNCTION_KEYS,
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'AudioVolumeDown',
  'AudioVolumeMute',
  'AudioVolumeUp',
  'MediaPlayPause',
  'MediaStop',
  'MediaTrackNext',
  'MediaTrackPrevious',
  'BrowserBack',
  'BrowserForward',
  'BrowserHome',
  'BrowserRefresh',
  'BrowserSearch',
])();

const MODIFIER_KEY_CODES = /* @__PURE__ */ new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'ShiftLeft',
  'ShiftRight',
  'CapsLock',
  'Fn',
  'FnLock',
  'NumLock',
]);

const TOKEN_OVERRIDES: Readonly<Record<string, string>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  BracketLeft: 'left-bracket',
  BracketRight: 'right-bracket',
  Backquote: 'grave',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

function kebab(code: string): string {
  return code.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function tokenFor(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  return TOKEN_OVERRIDES[code] ?? kebab(code);
}

const TOKEN_BY_CODE = /* @__PURE__ */ new Map(
  /* @__PURE__ */ BINDABLE_KEY_CODES.map((code) => [code, tokenFor(code)]),
);
const CODE_BY_TOKEN = /* @__PURE__ */ new Map(
  /* @__PURE__ */ BINDABLE_KEY_CODES.map((code) => [tokenFor(code), code]),
);

export function keyToken(code: string): string | undefined {
  return TOKEN_BY_CODE.get(code);
}

export function keyCodeForToken(token: string): string | undefined {
  return CODE_BY_TOKEN.get(token);
}

export function isBindableKeyCode(code: string): boolean {
  return TOKEN_BY_CODE.has(code);
}

export function isModifierKeyCode(code: string): boolean {
  return MODIFIER_KEY_CODES.has(code);
}

const FUNCTION_KEY_CODES = /* @__PURE__ */ new Set(FUNCTION_KEYS);

// Keys a user cannot reach by typing, so a bare binding still fires in a text field.
// Navigation and editing keys act on the text and stay with the field.
export function producesNoText(code: string): boolean {
  return code === 'Escape' || FUNCTION_KEY_CODES.has(code);
}

export type KeyboardLayoutFamily = 'iso' | 'jis';

const LAYOUT_EXCLUSIVE_KEYS: Readonly<Record<string, KeyboardLayoutFamily>> = {
  IntlBackslash: 'iso',
  IntlYen: 'jis',
  IntlRo: 'jis',
  NumpadComma: 'jis',
  KanaMode: 'jis',
  Lang1: 'jis',
  Lang2: 'jis',
  Convert: 'jis',
  NonConvert: 'jis',
};

export function layoutFamilyOfKey(code: string): KeyboardLayoutFamily | undefined {
  return LAYOUT_EXCLUSIVE_KEYS[code];
}
