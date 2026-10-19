import {
  MODIFIER_ORDER,
  type ModifierName,
  type Platform,
  type Shortcut,
  type Step,
} from './shortcut';

// Compatible with `KeyboardLayoutMap.get`: the character a key code produces on the
// user's layout, or undefined when unknown.
export type KeyboardLayout = (code: string) => string | undefined;

export interface DisplayOptions {
  readonly platform: Platform;
  readonly layout?: KeyboardLayout | undefined;
}

const US_LAYOUT: Readonly<Record<string, string>> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
};

export const usLayout: KeyboardLayout = (code) => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return US_LAYOUT[code];
};

const MAC_KEY_LABELS: Readonly<Record<string, string>> = {
  Enter: '↩',
  NumpadEnter: '⌤',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Tab: 'Tab',
};

const OTHER_KEY_LABELS: Readonly<Record<string, string>> = {
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Esc',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Tab: 'Tab',
};

const NUMPAD_LABELS: Readonly<Record<string, string>> = {
  NumpadAdd: '+',
  NumpadComma: ',',
  NumpadDecimal: '.',
  NumpadDivide: '/',
  NumpadEqual: '=',
  NumpadMultiply: '*',
  NumpadSubtract: '-',
};

const MAC_MODIFIER_SYMBOLS: Readonly<Record<ModifierName, string>> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
};

function modifierLabels(platform: Platform): Readonly<Record<ModifierName, string>> {
  const meta = platform === 'windows' ? 'Win' : platform === 'linux' ? 'Super' : 'Meta';
  return { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta };
}

function humanize(code: string): string {
  return code.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
}

function numpadLabel(code: string): string | undefined {
  const digit = /^Numpad([0-9])$/.exec(code)?.[1];
  const symbol = digit ?? NUMPAD_LABELS[code];
  return symbol === undefined ? undefined : `Num ${symbol}`;
}

export function keyLabel(code: string, options: DisplayOptions): string {
  const special = (options.platform === 'mac' ? MAC_KEY_LABELS : OTHER_KEY_LABELS)[code];
  if (special) return special;
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  const numpad = numpadLabel(code);
  if (numpad) return numpad;
  const character = options.layout?.(code) ?? usLayout(code);
  if (character) return character.toUpperCase();
  return humanize(code);
}

export function mouseButtonLabel(button: number): string {
  if (button === 0) return 'Left Click';
  if (button === 1) return 'Middle Click';
  if (button === 2) return 'Right Click';
  return `Mouse${button + 1}`;
}

export function stepLabel(step: Step, options: DisplayOptions): string {
  const input =
    step.input.type === 'key'
      ? keyLabel(step.input.code, options)
      : mouseButtonLabel(step.input.button);
  const active = MODIFIER_ORDER.filter((name) => step.modifiers[name]);
  if (options.platform === 'mac') {
    return active.map((name) => MAC_MODIFIER_SYMBOLS[name]).join('') + input;
  }
  const labels = modifierLabels(options.platform);
  return [...active.map((name) => labels[name]), input].join('+');
}

export function shortcutLabel(shortcut: Shortcut, options: DisplayOptions): string {
  return shortcut.steps.map((step) => stepLabel(step, options)).join(' ');
}
