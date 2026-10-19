import { describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  type KeyBindings,
  type ShortcutContext,
  boundOnly,
  defineContext,
  filterKeyBindings,
  fuzzyMatch,
  memoryStore,
  parseShortcut,
} from '../src';

const parse = (text: string) => parseShortcut(text, 'mac');

const registry = (contexts: readonly ShortcutContext[]) =>
  new ShortcutRegistry({
    contexts,
    platform: 'mac',
    store: memoryStore(),
    logger: { warn: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() },
  });

const table = (id: string) =>
  defineContext({
    id,
    actions: {
      save: { displayName: 'Save File', defaults: 'mod+s' },
      undo: { displayName: 'Undo Change', defaults: 'mod+z' },
      zoom: { displayName: 'Zoom', defaults: 'mod+equal' },
    },
  });

const actionIdsOf = (bindings: KeyBindings) =>
  bindings.groups.map((group) => [group.contextId, group.entries.map((entry) => entry.actionId)]);

describe('fuzzyMatch', () => {
  it('matches everything with score 0 for an empty query', () => {
    expect(fuzzyMatch('', 'Save')).toEqual({ score: 0, matched: [] });
  });

  it('scores a contiguous match above a scattered one of the same length', () => {
    const contiguous = fuzzyMatch('sav', 'Save File');
    const scattered = fuzzyMatch('sav', 'Search Above Vault');
    expect(contiguous?.score).toBeGreaterThan(scattered?.score ?? Infinity);
  });

  it('scores a start-of-word match above a mid-word match', () => {
    const start = fuzzyMatch('p', 'Print');
    const mid = fuzzyMatch('p', 'Compile');
    expect(start?.score).toBeGreaterThan(mid?.score ?? Infinity);
  });

  it('returns undefined when the query characters are not all present in order', () => {
    expect(fuzzyMatch('xyz', 'Save')).toBeUndefined();
    expect(fuzzyMatch('evas', 'Save')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('SAVE', 'save file')?.matched).toEqual([0, 1, 2, 3]);
    expect(fuzzyMatch('save', 'SAVE FILE')?.matched).toEqual([0, 1, 2, 3]);
  });

  it('reports the matched character indices', () => {
    expect(fuzzyMatch('sf', 'Save File')?.matched).toEqual([0, 5]);
  });
});

describe('key bindings snapshot', () => {
  it('has one group per context with one entry per action', () => {
    const reg = registry([table('editor')]);
    expect(actionIdsOf(reg.getSnapshot().keyBindings)).toEqual([
      ['editor', ['save', 'undo', 'zoom']],
    ]);
  });

  it('carries display name, effective shortcuts and customization', () => {
    const editor = table('editor');
    const reg = registry([editor]);
    reg.setShortcuts(editor, 'save', [parse('shift+meta+s')]);
    const save = reg
      .getSnapshot()
      .keyBindings.groups[0]?.entries.find((e) => e.actionId === 'save');
    expect(save).toMatchObject({
      id: 'editor.save',
      contextId: 'editor',
      displayName: 'Save File',
      shortcuts: [parse('shift+meta+s')],
      isCustomized: true,
    });
    const undo = reg
      .getSnapshot()
      .keyBindings.groups[0]?.entries.find((e) => e.actionId === 'undo');
    expect(undo?.isCustomized).toBe(false);
  });

  it('exposes every default binding of an action in order', () => {
    const multi = defineContext({
      id: 'editor',
      actions: { save: { displayName: 'Save', defaults: ['mod+s', 'ctrl+s'] } },
    });
    const entry = registry([multi]).getSnapshot().keyBindings.groups[0]?.entries[0];
    expect(entry?.shortcuts).toEqual([parse('meta+s'), parse('ctrl+s')]);
  });

  it('keeps dotted context and action ids distinct when indexing conflicts', () => {
    const dottedContext = defineContext({
      id: 'a.b',
      actions: { c: { displayName: 'Colliding', defaults: 'mod+s' } },
    });
    const dottedAction = defineContext({
      id: 'a',
      actions: { 'b.c': { displayName: 'Unrelated', defaults: 'mod+k' } },
    });
    const duplicate = defineContext({
      id: 'other',
      actions: { duplicate: { displayName: 'Duplicate', defaults: 'mod+s' } },
    });
    const entries = registry([dottedContext, dottedAction, duplicate])
      .getSnapshot()
      .keyBindings.groups.flatMap((group) => group.entries);
    const colliding = entries.find((e) => e.contextId === 'a.b' && e.actionId === 'c');
    const unrelated = entries.find((e) => e.contextId === 'a' && e.actionId === 'b.c');
    expect(colliding?.conflicts.map((c) => c.type)).toEqual(['duplicate']);
    expect(unrelated?.conflicts).toEqual([]);
  });
});

describe('filterKeyBindings', () => {
  it('narrows entries by display name', () => {
    const bindings = registry([table('editor')]).getSnapshot().keyBindings;
    expect(actionIdsOf(filterKeyBindings(bindings, 'save'))).toEqual([['editor', ['save']]]);
  });

  it('narrows entries by canonical shortcut text', () => {
    const bindings = registry([table('editor')]).getSnapshot().keyBindings;
    expect(actionIdsOf(filterKeyBindings(bindings, 'meta+z'))).toEqual([['editor', ['undo']]]);
  });

  it('returns the bindings unchanged for a blank query', () => {
    const bindings = registry([table('editor')]).getSnapshot().keyBindings;
    expect(filterKeyBindings(bindings, '   ')).toBe(bindings);
  });

  it('sorts entries by descending score', () => {
    const ctx = defineContext({
      id: 'editor',
      actions: {
        scattered: { displayName: 'Search Above Vault' },
        contiguous: { displayName: 'Save File' },
      },
    });
    const bindings = registry([ctx]).getSnapshot().keyBindings;
    expect(actionIdsOf(filterKeyBindings(bindings, 'sav'))).toEqual([
      ['editor', ['contiguous', 'scattered']],
    ]);
  });

  it('drops groups left without entries', () => {
    const other = defineContext({
      id: 'viewer',
      actions: { close: { displayName: 'Close', defaults: 'mod+w' } },
    });
    const bindings = registry([table('editor'), other]).getSnapshot().keyBindings;
    expect(actionIdsOf(filterKeyBindings(bindings, 'close'))).toEqual([['viewer', ['close']]]);
  });
});

describe('boundOnly', () => {
  it('keeps the requested contexts and only their bound entries', () => {
    const editor = defineContext({
      id: 'editor',
      actions: {
        save: { displayName: 'Save File', defaults: 'mod+s' },
        undo: { displayName: 'Undo Change', defaults: 'mod+z' },
        idle: { displayName: 'Idle' },
      },
    });
    const reg = registry([editor, table('viewer')]);
    expect(actionIdsOf(boundOnly(reg.bindings(['editor'])))).toEqual([
      ['editor', ['save', 'undo']],
    ]);
  });

  it('drops an action the user unbound and a group left empty', () => {
    const solo = defineContext({
      id: 'solo',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const reg = registry([solo, table('editor')]);
    reg.setShortcuts(solo, 'save', []);
    expect(actionIdsOf(boundOnly(reg.getSnapshot().keyBindings))).toEqual([
      ['editor', ['save', 'undo', 'zoom']],
    ]);
  });
});
