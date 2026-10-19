import { describe, expect, it } from 'vitest';
import {
  BINDABLE_KEY_CODES,
  ShortcutParseError,
  formatShortcut,
  formatStep,
  isPrefixOf,
  keyCodeForToken,
  keyStep,
  keyToken,
  modifiers,
  mouseStep,
  parseShortcut,
  sameShortcut,
  shortcutOf,
  tryParseShortcut,
  type ShortcutParseErrorReason,
} from '../src';

const roundTrip = (text: string) => formatShortcut(parseShortcut(text, 'mac'));

const parseError = (text: string): { reason: ShortcutParseErrorReason; token: string } => {
  try {
    parseShortcut(text, 'mac');
  } catch (error) {
    if (error instanceof ShortcutParseError) return { reason: error.reason, token: error.token };
    throw error;
  }
  throw new Error(`"${text}" parsed`);
};

describe('shortcut text syntax', () => {
  it('round-trips a key with a modifier', () => {
    const shortcut = parseShortcut('meta+s', 'mac');
    expect(shortcut).toEqual(shortcutOf(keyStep('KeyS', modifiers(['meta']))));
    expect(formatShortcut(shortcut)).toBe('meta+s');
  });

  it('parses multiple modifiers in any order and emits them canonically', () => {
    const expected = shortcutOf(keyStep('KeyA', modifiers(['meta', 'shift'])));
    expect(parseShortcut('shift+meta+a', 'mac')).toEqual(expected);
    expect(parseShortcut('meta+shift+a', 'mac')).toEqual(expected);
    expect(formatShortcut(expected)).toBe('shift+meta+a');
    expect(roundTrip('meta+shift+alt+ctrl+k')).toBe('ctrl+alt+shift+meta+k');
  });

  it('round-trips a multi-step shortcut', () => {
    const shortcut = parseShortcut('meta+k meta+c', 'mac');
    expect(shortcut.steps).toHaveLength(2);
    expect(formatShortcut(shortcut)).toBe('meta+k meta+c');
  });

  it('collapses surrounding and repeated whitespace between steps', () => {
    expect(roundTrip('  meta+k   meta+c ')).toBe('meta+k meta+c');
  });

  it('round-trips mouse buttons and special keys', () => {
    expect(roundTrip('ctrl+right-click')).toBe('ctrl+right-click');
    expect(roundTrip('left-click')).toBe('left-click');
    expect(roundTrip('middle-click')).toBe('middle-click');
    expect(roundTrip('tab')).toBe('tab');
    expect(roundTrip('escape')).toBe('escape');
    expect(roundTrip('enter')).toBe('enter');
    expect(roundTrip('backspace')).toBe('backspace');
    expect(roundTrip('delete')).toBe('delete');
    expect(roundTrip('space')).toBe('space');
    expect(roundTrip('shift+f5')).toBe('shift+f5');
  });

  it('maps mouse tokens to web button numbers', () => {
    expect(parseShortcut('left-click', 'mac')).toEqual(shortcutOf(mouseStep(0)));
    expect(parseShortcut('middle-click', 'mac')).toEqual(shortcutOf(mouseStep(1)));
    expect(parseShortcut('right-click', 'mac')).toEqual(shortcutOf(mouseStep(2)));
  });

  it('round-trips a generic buttonN token as button N-1', () => {
    const step = mouseStep(5);
    expect(formatStep(step)).toBe('button6');
    expect(parseShortcut('button6', 'mac')).toEqual(shortcutOf(step));
    expect(parseShortcut('button4', 'mac')).toEqual(shortcutOf(mouseStep(3)));
    expect(formatStep(mouseStep(3))).toBe('button4');
  });

  it('formats the named buttons by name even when written as buttonN', () => {
    expect(roundTrip('button1')).toBe('left-click');
    expect(roundTrip('button2')).toBe('middle-click');
    expect(roundTrip('button3')).toBe('right-click');
  });

  it('resolves mod to meta on mac and ctrl elsewhere', () => {
    expect(parseShortcut('mod+s', 'mac')).toEqual(shortcutOf(keyStep('KeyS', modifiers(['meta']))));
    expect(parseShortcut('mod+s', 'windows')).toEqual(
      shortcutOf(keyStep('KeyS', modifiers(['ctrl']))),
    );
    expect(parseShortcut('mod+s', 'linux')).toEqual(
      shortcutOf(keyStep('KeyS', modifiers(['ctrl']))),
    );
  });

  it('reports parse errors with their reason and token', () => {
    expect(parseError('')).toEqual({ reason: 'empty', token: '' });
    expect(parseError('   ')).toEqual({ reason: 'empty', token: '' });
    expect(parseError('hyper+s')).toEqual({ reason: 'unknownModifier', token: 'hyper' });
    expect(parseError('meta+notakey')).toEqual({ reason: 'unknownKey', token: 'notakey' });
    expect(parseError('meta++s')).toEqual({ reason: 'emptyStep', token: 'meta++s' });
    expect(parseError('meta+')).toEqual({ reason: 'emptyStep', token: 'meta+' });
  });

  it('treats tokens as case-sensitive', () => {
    expect(parseError('Meta+s')).toEqual({ reason: 'unknownModifier', token: 'Meta' });
    expect(parseError('meta+S')).toEqual({ reason: 'unknownKey', token: 'S' });
  });

  it('returns undefined from tryParseShortcut for invalid text', () => {
    expect(tryParseShortcut('hyper+s', 'mac')).toBeUndefined();
    expect(tryParseShortcut('meta+s', 'mac')).toEqual(
      shortcutOf(keyStep('KeyS', modifiers(['meta']))),
    );
  });

  it('round-trips punctuation keys', () => {
    for (const text of [
      'meta+semicolon',
      'meta+left-bracket',
      'meta+right-bracket',
      'alt+minus',
      'shift+equal',
      'meta+comma',
      'meta+period',
      'meta+slash',
      'meta+backslash',
      'meta+quote',
      'meta+grave',
    ]) {
      expect(roundTrip(text)).toBe(text);
    }
  });

  it('uses the overridden tokens for arrows, brackets, backquote and paging keys', () => {
    expect(keyToken('ArrowUp')).toBe('up');
    expect(keyToken('ArrowDown')).toBe('down');
    expect(keyToken('ArrowLeft')).toBe('left');
    expect(keyToken('ArrowRight')).toBe('right');
    expect(keyToken('BracketLeft')).toBe('left-bracket');
    expect(keyToken('BracketRight')).toBe('right-bracket');
    expect(keyToken('Backquote')).toBe('grave');
    expect(keyToken('PageUp')).toBe('pageup');
    expect(keyToken('PageDown')).toBe('pagedown');
  });

  it('derives letter, digit and kebab-case tokens from key codes', () => {
    expect(keyToken('KeyK')).toBe('k');
    expect(keyToken('Digit1')).toBe('1');
    expect(keyToken('Escape')).toBe('escape');
    expect(keyToken('NumpadAdd')).toBe('numpad-add');
    expect(keyToken('Numpad7')).toBe('numpad7');
    expect(keyToken('AudioVolumeUp')).toBe('audio-volume-up');
    expect(keyToken('F12')).toBe('f12');
  });

  it('gives every bindable key code a unique token that maps back to it', () => {
    const tokens = BINDABLE_KEY_CODES.map((code) => keyToken(code));
    expect(new Set(tokens).size).toBe(BINDABLE_KEY_CODES.length);
    expect(BINDABLE_KEY_CODES.map((code) => keyCodeForToken(keyToken(code) ?? ''))).toEqual(
      BINDABLE_KEY_CODES,
    );
  });

  it('round-trips every bindable key through text', () => {
    for (const code of BINDABLE_KEY_CODES) {
      const shortcut = shortcutOf(keyStep(code, modifiers(['ctrl', 'shift'])));
      expect(parseShortcut(formatShortcut(shortcut), 'mac')).toEqual(shortcut);
    }
  });

  it('refuses to format a key code that is not bindable', () => {
    expect(() => formatShortcut(shortcutOf(keyStep('MetaLeft')))).toThrow(/MetaLeft/);
  });
});

describe('shortcut model', () => {
  it('stores the input and modifiers of a key step', () => {
    const step = keyStep('KeyJ', modifiers(['meta', 'shift']));
    expect(step.input).toEqual({ type: 'key', code: 'KeyJ' });
    expect(step.modifiers).toEqual({ ctrl: false, alt: false, shift: true, meta: true });
  });

  it('builds a single-step shortcut', () => {
    const shortcut = shortcutOf(keyStep('KeyJ', modifiers(['meta'])));
    expect(shortcut.steps).toHaveLength(1);
    expect(shortcut.steps[0]?.input).toEqual({ type: 'key', code: 'KeyJ' });
    expect(shortcut.steps[0]?.modifiers).toEqual(modifiers(['meta']));
  });

  it('preserves step order', () => {
    const steps = [keyStep('KeyJ', modifiers(['meta'])), keyStep('KeyS', modifiers(['meta']))];
    expect(shortcutOf(...steps).steps).toEqual(steps);
  });

  it('accepts steps of mixed kinds', () => {
    const steps = [keyStep('KeyK', modifiers(['meta'])), mouseStep(1), keyStep('Escape')];
    expect(shortcutOf(...steps).steps).toEqual(steps);
  });

  it('requires at least one step', () => {
    expect(() => shortcutOf()).toThrow('at least one step');
  });

  it('compares shortcuts step by step', () => {
    const a = shortcutOf(keyStep('KeyJ', modifiers(['meta'])));
    const b = shortcutOf(keyStep('KeyJ', modifiers(['meta'])));
    const other = shortcutOf(keyStep('KeyS', modifiers(['meta'])));
    const otherModifiers = shortcutOf(keyStep('KeyJ', modifiers(['ctrl'])));
    const longer = shortcutOf(keyStep('KeyJ', modifiers(['meta'])), keyStep('KeyS'));
    const mouse = shortcutOf(mouseStep(0, modifiers(['meta'])));
    expect(sameShortcut(a, b)).toBe(true);
    expect(sameShortcut(a, other)).toBe(false);
    expect(sameShortcut(a, otherModifiers)).toBe(false);
    expect(sameShortcut(a, longer)).toBe(false);
    expect(sameShortcut(a, mouse)).toBe(false);
  });

  it('recognises a strict prefix', () => {
    const chord = parseShortcut('meta+k meta+c', 'mac');
    expect(isPrefixOf(parseShortcut('meta+k', 'mac'), chord)).toBe(true);
    expect(isPrefixOf(chord, chord)).toBe(false);
    expect(isPrefixOf(parseShortcut('meta+c', 'mac'), chord)).toBe(false);
  });

  it('round-trips single, multi-step and mixed shortcuts through text', () => {
    const shortcuts = [
      shortcutOf(keyStep('KeyJ', modifiers(['meta', 'shift']))),
      shortcutOf(keyStep('KeyK', modifiers(['meta'])), keyStep('KeyC', modifiers(['meta']))),
      shortcutOf(
        keyStep('KeyK', modifiers(['meta'])),
        mouseStep(1),
        mouseStep(4, modifiers(['shift'])),
        keyStep('ArrowDown'),
      ),
    ];
    for (const shortcut of shortcuts) {
      expect(sameShortcut(parseShortcut(formatShortcut(shortcut), 'mac'), shortcut)).toBe(true);
    }
  });

  it('is built the same through text and through the step helpers', () => {
    expect(parseShortcut('meta+j', 'mac')).toEqual(
      shortcutOf(keyStep('KeyJ', modifiers(['meta']))),
    );
    expect(parseShortcut('alt+right-click', 'mac')).toEqual(
      shortcutOf(mouseStep(2, modifiers(['alt']))),
    );
  });
});
