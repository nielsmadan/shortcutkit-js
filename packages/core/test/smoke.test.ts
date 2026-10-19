import { describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  defineContext,
  formatShortcut,
  memoryStore,
  modifiers,
  parseShortcut,
  shortcutLabel,
  type ShortcutInput,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    chord: { displayName: 'Chord', defaults: 'mod+k mod+c' },
    search: { displayName: 'Search', defaults: 'k' },
  },
});

const key = (
  code: string,
  mods: Parameters<typeof modifiers>[0] = [],
  extra: Partial<ShortcutInput> = {},
): ShortcutInput => ({ type: 'key', code, modifiers: modifiers(mods), ...extra }) as ShortcutInput;

describe('smoke', () => {
  it('parses, formats and labels', () => {
    const shortcut = parseShortcut('mod+shift+k left-click', 'mac');
    expect(formatShortcut(shortcut)).toBe('shift+meta+k left-click');
    expect(shortcutLabel(shortcut, { platform: 'mac' })).toBe('⇧⌘K Left Click');
    expect(shortcutLabel(parseShortcut('mod+shift+k', 'windows'), { platform: 'windows' })).toBe(
      'Ctrl+Shift+K',
    );
  });

  it('dispatches through an activation and persists overrides', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const registry = await createRegistry({ contexts: [editor], platform: 'mac', store });
    const fired: string[] = [];
    registry.activate(editor, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('fired');
    expect(registry.handleInput(key('MetaLeft', ['meta']))).toBe('ignored');
    expect(registry.handleInput(key('KeyK', ['meta']))).toBe('advanced');
    expect(registry.handleInput(key('MetaLeft', ['meta']))).toBe('ignored');
    expect(registry.handleInput(key('KeyC', ['meta']))).toBe('fired');
    expect(registry.handleInput(key('KeyK', [], { editingText: true }))).toBe('ignored');
    expect(registry.handleInput(key('KeyK'))).toBe('fired');
    expect(fired).toEqual(['save', 'chord', 'search']);

    registry.setShortcuts(editor, 'save', [parseShortcut('ctrl+s', 'mac')]);
    expect(registry.getSnapshot().keyBindings.groups[0]?.entries[0]?.isCustomized).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.current).toEqual({ overrides: { editor: { save: ['ctrl+s'] } }, preferences: {} });
    expect(registry.handleInput(key('KeyS', ['ctrl']))).toBe('fired');
    vi.useRealTimers();
  });
});
