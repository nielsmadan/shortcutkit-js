import { describe, expect, it } from 'vitest';
import {
  keyLabel,
  keyStep,
  modifiers,
  mouseButtonLabel,
  mouseStep,
  parseShortcut,
  shortcutLabel,
  shortcutOf,
  usLayout,
  type KeyboardLayout,
  type Platform,
} from '../src';

const mac = (text: string) => shortcutLabel(parseShortcut(text, 'mac'), { platform: 'mac' });
const on = (platform: Platform, text: string) =>
  shortcutLabel(parseShortcut(text, platform), { platform });

describe('mac labels', () => {
  it('labels a special key alone', () => {
    expect(mac('enter')).toBe('↩');
  });

  it('prefixes a special key with its modifier symbol', () => {
    expect(mac('meta+enter')).toBe('⌘↩');
  });

  it('labels a letter by its character', () => {
    expect(mac('s')).toBe('S');
  });

  it('prefixes a letter with shift and command', () => {
    expect(mac('meta+shift+j')).toBe('⇧⌘J');
  });

  it('orders modifier symbols control, option, shift, command', () => {
    expect(mac('meta+shift+alt+ctrl+k')).toBe('⌃⌥⇧⌘K');
    expect(mac('alt+ctrl+left-click')).toBe('⌃⌥Left Click');
  });

  it('labels tab with a modifier', () => {
    expect(
      shortcutLabel(shortcutOf(keyStep('Tab', modifiers(['meta']))), { platform: 'mac' }),
    ).toBe('⌘Tab');
  });

  it('joins the steps of a multi-step shortcut with a space', () => {
    expect(mac('meta+tab meta+enter')).toBe('⌘Tab ⌘↩');
  });

  it('labels the special keys with their mac symbols', () => {
    expect(mac('backspace')).toBe('⌫');
    expect(mac('delete')).toBe('⌦');
    expect(mac('escape')).toBe('⎋');
    expect(mac('home')).toBe('↖');
    expect(mac('end')).toBe('↘');
    expect(mac('pageup')).toBe('⇞');
    expect(mac('pagedown')).toBe('⇟');
    expect(mac('up down left right')).toBe('↑ ↓ ← →');
    expect(mac('space')).toBe('Space');
    expect(mac('numpad-enter')).toBe('⌤');
  });

  it('labels function keys by name', () => {
    expect(mac('f1')).toBe('F1');
    expect(mac('shift+f12')).toBe('⇧F12');
    expect(mac('f20')).toBe('F20');
  });
});

describe('mouse button labels', () => {
  it('labels the left button', () => {
    expect(shortcutLabel(shortcutOf(mouseStep(0)), { platform: 'mac' })).toBe('Left Click');
  });

  it('labels the middle button', () => {
    expect(shortcutLabel(shortcutOf(mouseStep(1)), { platform: 'mac' })).toBe('Middle Click');
  });

  it('labels the right button', () => {
    expect(shortcutLabel(shortcutOf(mouseStep(2)), { platform: 'mac' })).toBe('Right Click');
  });

  it('labels extra buttons one-indexed', () => {
    expect(mouseButtonLabel(3)).toBe('Mouse4');
    expect(mouseButtonLabel(4)).toBe('Mouse5');
  });

  it('prefixes a mouse button with its modifier', () => {
    expect(mac('ctrl+right-click')).toBe('⌃Right Click');
    expect(on('windows', 'ctrl+right-click')).toBe('Ctrl+Right Click');
  });
});

describe('non-mac labels', () => {
  it('names the meta modifier per platform', () => {
    expect(on('windows', 'meta+k')).toBe('Win+K');
    expect(on('linux', 'meta+k')).toBe('Super+K');
    expect(on('other', 'meta+k')).toBe('Meta+K');
  });

  it('joins modifiers in order with plus signs', () => {
    expect(on('windows', 'meta+shift+alt+ctrl+k')).toBe('Ctrl+Alt+Shift+Win+K');
    expect(on('linux', 'mod+k mod+c')).toBe('Ctrl+K Ctrl+C');
  });

  it('labels special keys by name', () => {
    expect(on('windows', 'enter')).toBe('Enter');
    expect(on('windows', 'escape')).toBe('Esc');
    expect(on('windows', 'backspace')).toBe('Backspace');
    expect(on('windows', 'delete')).toBe('Delete');
    expect(on('windows', 'up down left right')).toBe('Up Down Left Right');
    expect(on('windows', 'pageup pagedown home end')).toBe('PageUp PageDown Home End');
    expect(on('windows', 'numpad-enter')).toBe('Num Enter');
    expect(on('windows', 'ctrl+tab')).toBe('Ctrl+Tab');
  });
});

describe('key labels', () => {
  it('maps US-layout letters and digits to their characters', () => {
    expect(usLayout('KeyA')).toBe('a');
    expect(usLayout('KeyS')).toBe('s');
    expect(usLayout('Digit7')).toBe('7');
    expect(usLayout('Semicolon')).toBe(';');
    expect(usLayout('F5')).toBeUndefined();
  });

  it('labels punctuation by its US character', () => {
    expect(mac('meta+left-bracket')).toBe('⌘[');
    expect(mac('meta+grave')).toBe('⌘`');
    expect(mac('meta+comma')).toBe('⌘,');
    expect(on('windows', 'ctrl+slash')).toBe('Ctrl+/');
    expect(mac('alt+1')).toBe('⌥1');
  });

  it('labels numpad keys with a Num prefix', () => {
    expect(keyLabel('Numpad1', { platform: 'mac' })).toBe('Num 1');
    expect(keyLabel('NumpadAdd', { platform: 'windows' })).toBe('Num +');
    expect(keyLabel('NumpadMultiply', { platform: 'mac' })).toBe('Num *');
  });

  it('humanizes keys with no character or special label', () => {
    expect(keyLabel('IntlBackslash', { platform: 'mac' })).toBe('Intl Backslash');
    expect(keyLabel('AudioVolumeUp', { platform: 'windows' })).toBe('Audio Volume Up');
  });

  it('uses the layout for the character a key produces', () => {
    const azerty: KeyboardLayout = (code) =>
      ({ KeyQ: 'a', KeyA: 'q', Semicolon: 'm', IntlBackslash: '<' })[code];
    const options = { platform: 'mac', layout: azerty } as const;
    expect(shortcutLabel(parseShortcut('meta+q', 'mac'), options)).toBe('⌘A');
    expect(shortcutLabel(parseShortcut('meta+a', 'mac'), options)).toBe('⌘Q');
    expect(keyLabel('Semicolon', options)).toBe('M');
    expect(keyLabel('IntlBackslash', options)).toBe('<');
  });

  it('falls back to the US layout for keys the layout does not know', () => {
    const empty: KeyboardLayout = () => undefined;
    expect(keyLabel('KeyK', { platform: 'mac', layout: empty })).toBe('K');
  });

  it('keeps special-key labels regardless of the layout', () => {
    const layout: KeyboardLayout = () => 'x';
    expect(keyLabel('Enter', { platform: 'mac', layout })).toBe('↩');
    expect(keyLabel('F5', { platform: 'windows', layout })).toBe('F5');
  });
});
