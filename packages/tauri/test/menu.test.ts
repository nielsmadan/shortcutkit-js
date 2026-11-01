import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  defineContext,
  memoryStore,
  modifiers,
  parseShortcut,
  type Platform,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import {
  predefinedMenuShortcuts,
  syncMenuAccelerators,
  toAccelerator,
  type MenuBinding,
} from '../guest-js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    find: { displayName: 'Find', defaults: 'mod+f' },
  },
});

const bare = defineContext({
  id: 'bare',
  actions: {
    unbound: { displayName: 'Unbound' },
    chord: { displayName: 'Chord', defaults: 'mod+k mod+c' },
  },
});

const accel = (text: string, platform: Platform) =>
  toAccelerator(parseShortcut(text, platform), platform);

const byCode = (code: string, platform: Platform) =>
  toAccelerator(
    { steps: [{ input: { type: 'key', code }, modifiers: modifiers(['ctrl']) }] },
    platform,
  );

describe('toAccelerator', () => {
  it('formats mod+shift+k per platform', () => {
    expect(accel('mod+shift+k', 'mac')).toBe('Shift+Cmd+KeyK');
    expect(accel('mod+shift+k', 'windows')).toBe('Ctrl+Shift+KeyK');
    expect(accel('mod+shift+k', 'linux')).toBe('Ctrl+Shift+KeyK');
  });

  it('orders modifiers Ctrl, Alt, Shift, then meta', () => {
    expect(accel('ctrl+alt+shift+meta+k', 'mac')).toBe('Ctrl+Alt+Shift+Cmd+KeyK');
    expect(accel('ctrl+alt+shift+meta+k', 'linux')).toBe('Ctrl+Alt+Shift+Super+KeyK');
    expect(accel('alt+1', 'windows')).toBe('Alt+Digit1');
  });

  it('accepts F-keys, Escape, numpad and punctuation', () => {
    expect(accel('f5', 'mac')).toBe('F5');
    expect(accel('shift+f24', 'windows')).toBe('Shift+F24');
    expect(accel('escape', 'mac')).toBe('Escape');
    expect(accel('mod+numpad0', 'windows')).toBe('Ctrl+Numpad0');
    expect(byCode('NumpadAdd', 'mac')).toBe('Ctrl+NumpadAdd');
    expect(byCode('ArrowUp', 'mac')).toBe('Ctrl+ArrowUp');
    expect(byCode('Slash', 'windows')).toBe('Ctrl+Slash');
  });

  it('returns undefined for unsupported shortcuts', () => {
    expect(accel('mod+k mod+s', 'mac')).toBeUndefined();
    expect(accel('button1', 'mac')).toBeUndefined();
    expect(byCode('IntlBackslash', 'mac')).toBeUndefined();
    expect(accel('meta+k', 'windows')).toBeUndefined();
    expect(accel('k', 'mac')).toBeUndefined();
    expect(byCode('F25', 'mac')).toBeUndefined();
  });
});

describe('predefinedMenuShortcuts', () => {
  const ALL_KINDS = [
    'Copy',
    'Cut',
    'Paste',
    'Undo',
    'Redo',
    'SelectAll',
    'Minimize',
    'Hide',
    'HideOthers',
    'CloseWindow',
    'Quit',
    'Fullscreen',
  ] as const;

  const rows = (platform: Platform) =>
    predefinedMenuShortcuts(platform, ALL_KINDS).map((item) => [
      item.title,
      toAccelerator(item.shortcut, platform),
    ]);

  it('mirrors muda on macOS', () => {
    expect(rows('mac')).toEqual([
      ['Copy', 'Cmd+KeyC'],
      ['Cut', 'Cmd+KeyX'],
      ['Paste', 'Cmd+KeyV'],
      ['Undo', 'Cmd+KeyZ'],
      ['Redo', 'Shift+Cmd+KeyZ'],
      ['SelectAll', 'Cmd+KeyA'],
      ['Minimize', 'Cmd+KeyM'],
      ['Hide', 'Cmd+KeyH'],
      ['HideOthers', 'Alt+Cmd+KeyH'],
      ['CloseWindow', 'Cmd+KeyW'],
      ['Quit', 'Cmd+KeyQ'],
      ['Fullscreen', 'Ctrl+Cmd+KeyF'],
    ]);
  });

  it('omits kinds muda creates disabled', () => {
    expect(predefinedMenuShortcuts('windows', ['HideOthers', 'Copy']).map((i) => i.title)).toEqual([
      'Copy',
    ]);
    expect(
      predefinedMenuShortcuts('linux', ['Undo', 'CloseWindow', 'Paste']).map((i) => i.title),
    ).toEqual(['Paste']);
  });

  it('mirrors muda on Windows and omits HideOthers, Quit and Fullscreen', () => {
    expect(rows('windows')).toEqual([
      ['Copy', 'Ctrl+KeyC'],
      ['Cut', 'Ctrl+KeyX'],
      ['Paste', 'Ctrl+KeyV'],
      ['Undo', 'Ctrl+KeyZ'],
      ['Redo', 'Ctrl+KeyY'],
      ['SelectAll', 'Ctrl+KeyA'],
      ['Minimize', 'Ctrl+KeyM'],
      ['Hide', 'Ctrl+KeyH'],
      ['CloseWindow', 'Alt+F4'],
    ]);
  });

  it('mirrors muda on Linux and omits the kinds gtk creates disabled', () => {
    expect(rows('linux')).toEqual([
      ['Copy', 'Ctrl+KeyC'],
      ['Cut', 'Ctrl+KeyX'],
      ['Paste', 'Ctrl+KeyV'],
      ['SelectAll', 'Ctrl+KeyA'],
    ]);
  });
});

function fakeItem() {
  const calls: (string | null)[] = [];
  const pending: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  let manual = false;
  let failWith: unknown;
  return {
    calls,
    pending,
    holdResponses: () => (manual = true),
    failNext: (error: unknown) => (failWith = error),
    item: {
      setAccelerator(accelerator: string | null): Promise<void> {
        calls.push(accelerator);
        if (failWith !== undefined) {
          const error = failWith;
          failWith = undefined;
          return Promise.reject(error);
        }
        if (!manual) return Promise.resolve();
        return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
  };
}

async function setup() {
  const registry: ShortcutRegistry = await createRegistry({
    contexts: [editor],
    platform: 'mac',
    store: memoryStore(),
    saveDebounceMs: 0,
  });
  const save = fakeItem();
  const find = fakeItem();
  const bindings: MenuBinding[] = [
    { item: save.item, context: editor, action: 'save' },
    { item: find.item, context: editor, action: 'find' },
  ];
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) };
  const stop = syncMenuAccelerators(registry, bindings, { logger });
  return { registry, save, find, warnings, stop };
}

describe('syncMenuAccelerators', () => {
  it('sets the initial accelerators', async () => {
    const { save, find } = await setup();
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS']);
    expect(find.calls).toEqual(['Cmd+KeyF']);
  });

  it('sends null at start for actions without a usable first shortcut', async () => {
    const registry = await createRegistry({
      contexts: [bare],
      platform: 'mac',
      store: memoryStore(),
    });
    const unbound = fakeItem();
    const chord = fakeItem();
    syncMenuAccelerators(registry, [
      { item: unbound.item, context: bare, action: 'unbound' },
      { item: chord.item, context: bare, action: 'chord' },
    ]);
    await tick();
    expect(unbound.calls).toEqual([null]);
    expect(chord.calls).toEqual([null]);
  });

  it('updates after setShortcuts and skips unchanged items', async () => {
    const { registry, save, find } = await setup();
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+shift+s', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Shift+Cmd+KeyS']);
    expect(find.calls).toEqual(['Cmd+KeyF']);
  });

  it('sends null after removal and for unsupported first shortcuts', async () => {
    const { registry, save, find } = await setup();
    registry.setShortcuts(editor, 'save', []);
    registry.setShortcuts(editor, 'find', [parseShortcut('mod+k mod+f', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', null]);
    expect(find.calls).toEqual(['Cmd+KeyF', null]);
  });

  it('keeps going after one item rejects', async () => {
    const { registry, save, find, warnings } = await setup();
    await tick();
    save.failNext(new Error('boom'));
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+shift+s', 'mac')]);
    registry.setShortcuts(editor, 'find', [parseShortcut('mod+shift+f', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Shift+Cmd+KeyS']);
    expect(find.calls).toEqual(['Cmd+KeyF', 'Shift+Cmd+KeyF']);
    expect(warnings).toEqual(['ShortcutKit: setAccelerator failed for editor.save: Error: boom']);
  });

  it('retries a rejected accelerator on the next publish', async () => {
    const { registry, save, warnings } = await setup();
    await tick();
    save.failNext(new Error('boom'));
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+shift+s', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Shift+Cmd+KeyS']);
    registry.setShortcuts(editor, 'find', [parseShortcut('mod+shift+f', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Shift+Cmd+KeyS', 'Shift+Cmd+KeyS']);
    expect(warnings).toEqual(['ShortcutKit: setAccelerator failed for editor.save: Error: boom']);
  });

  it('sends the newer value when a rejected one was superseded meanwhile', async () => {
    const { registry, save } = await setup();
    await tick();
    save.holdResponses();
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+1', 'mac')]);
    await tick();
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+2', 'mac')]);
    save.pending[0]?.reject(new Error('boom'));
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Cmd+Digit1', 'Cmd+Digit2']);
  });

  it('lets the last value win when updates overlap', async () => {
    const { registry, save } = await setup();
    await tick();
    save.holdResponses();
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+1', 'mac')]);
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+2', 'mac')]);
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+3', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Cmd+Digit1']);
    save.pending[0]?.resolve();
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Cmd+Digit1', 'Cmd+Digit3']);
  });

  it('stops syncing when the returned function is called', async () => {
    const { registry, save, stop } = await setup();
    await tick();
    stop();
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+shift+s', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS']);
  });
});

describe('syncMenuAccelerators stop while in flight', () => {
  it('does not send the queued latest value after stop', async () => {
    const { registry, save, stop } = await setup();
    await tick();
    save.holdResponses();
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+1', 'mac')]);
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Cmd+Digit1']);
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+2', 'mac')]);
    stop();
    save.pending[0]?.resolve();
    await tick();
    expect(save.calls).toEqual(['Cmd+KeyS', 'Cmd+Digit1']);
  });
});

describe('menu collisions', () => {
  it('finds a binding that equals a predefined item', async () => {
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      store: memoryStore(),
    });
    registry.setShortcuts(editor, 'save', [parseShortcut('mod+q', 'mac')]);
    const collisions = registry.menuCollisions(predefinedMenuShortcuts('mac', ['Quit', 'Copy']));
    expect(collisions.map((c) => (c.type === 'menuCollision' ? c.menuItemTitle : c.type))).toEqual([
      'Quit',
    ]);
  });
});
