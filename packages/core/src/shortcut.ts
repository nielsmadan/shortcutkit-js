export type Platform = 'mac' | 'windows' | 'linux' | 'other';

export interface Modifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export type ModifierName = keyof Modifiers;

export const MODIFIER_ORDER: readonly ModifierName[] = ['ctrl', 'alt', 'shift', 'meta'];

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false, shift: false, meta: false };

export type StepInput =
  | { readonly type: 'key'; readonly code: string }
  | { readonly type: 'mouse'; readonly button: number };

export interface Step {
  readonly input: StepInput;
  readonly modifiers: Modifiers;
}

export interface Shortcut {
  readonly steps: readonly Step[];
}

export function modifiers(names: Iterable<ModifierName> = []): Modifiers {
  const set = new Set(names);
  return {
    ctrl: set.has('ctrl'),
    alt: set.has('alt'),
    shift: set.has('shift'),
    meta: set.has('meta'),
  };
}

export function sameModifiers(a: Modifiers, b: Modifiers): boolean {
  return MODIFIER_ORDER.every((name) => a[name] === b[name]);
}

export function keyStep(code: string, mods: Modifiers = NO_MODIFIERS): Step {
  return { input: { type: 'key', code }, modifiers: mods };
}

export function mouseStep(button: number, mods: Modifiers = NO_MODIFIERS): Step {
  return { input: { type: 'mouse', button }, modifiers: mods };
}

export function shortcutOf(...steps: Step[]): Shortcut {
  if (steps.length === 0) throw new Error('A shortcut needs at least one step');
  return { steps };
}

export function sameInput(a: StepInput, b: StepInput): boolean {
  if (a.type === 'key') return b.type === 'key' && a.code === b.code;
  return b.type === 'mouse' && a.button === b.button;
}

export function sameStep(a: Step, b: Step): boolean {
  return sameInput(a.input, b.input) && sameModifiers(a.modifiers, b.modifiers);
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return (
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => {
      const other = b.steps[index];
      return other !== undefined && sameStep(step, other);
    })
  );
}

export function isPrefixOf(prefix: Shortcut, full: Shortcut): boolean {
  return (
    prefix.steps.length < full.steps.length &&
    prefix.steps.every((step, index) => {
      const other = full.steps[index];
      return other !== undefined && sameStep(step, other);
    })
  );
}

export function primaryModifier(platform: Platform): ModifierName {
  return platform === 'mac' ? 'meta' : 'ctrl';
}
