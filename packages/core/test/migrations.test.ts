import { describe, expect, it, vi } from 'vitest';
import {
  type RawState,
  type ShortcutMigration,
  applyMigrations,
  applyMigrationsBestEffort,
  createRegistry,
  defineContext,
  memoryStore,
  parseShortcut,
  setBindings,
} from '../src';

const state = (overrides: RawState['overrides']): RawState => ({ overrides, preferences: {} });

const rename: ShortcutMigration = {
  type: 'renameAction',
  context: 'editor',
  from: 'save',
  to: 'saveFile',
};

class DemoError extends Error {}

const throwing: ShortcutMigration = {
  type: 'custom',
  apply: () => {
    throw new DemoError('boom');
  },
};

describe('applyMigrations', () => {
  it('renameAction moves a key', () => {
    expect(applyMigrations(state({ editor: { save: ['meta+s'] } }), [rename]).overrides).toEqual({
      editor: { saveFile: ['meta+s'] },
    });
  });

  it('renameAction is idempotent', () => {
    expect(
      applyMigrations(state({ editor: { save: ['meta+s'] } }), [rename, rename]).overrides,
    ).toEqual({
      editor: { saveFile: ['meta+s'] },
    });
  });

  it('renameAction with an absent source is a no-op', () => {
    const s = state({ editor: { undo: ['meta+z'] } });
    expect(applyMigrations(s, [rename])).toEqual(s);
  });

  it('renameAction carries an unbound override', () => {
    expect(applyMigrations(state({ editor: { save: [] } }), [rename]).overrides).toEqual({
      editor: { saveFile: [] },
    });
  });

  it('renameAction collision: source wins and a warning is reported', () => {
    const warn = vi.fn<(message: string) => void>();
    const migrated = applyMigrations(
      state({ editor: { save: ['meta+s'], saveFile: ['shift+meta+s'] } }),
      [rename],
      warn,
    );
    expect(migrated.overrides).toEqual({ editor: { saveFile: ['meta+s'] } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('editor.saveFile');
  });

  it('moveAction relocates between contexts and prunes the emptied source', () => {
    const migrated = applyMigrations(state({ editor: { save: ['meta+s'] } }), [
      {
        type: 'moveAction',
        from: { contextId: 'editor', actionId: 'save' },
        to: { contextId: 'files', actionId: 'save' },
      },
    ]);
    expect(migrated.overrides).toEqual({ files: { save: ['meta+s'] } });
  });

  it('moveAction collision: source wins and a warning is reported', () => {
    const warn = vi.fn<(message: string) => void>();
    const migrated = applyMigrations(
      state({ editor: { save: ['meta+s'] }, files: { save: ['ctrl+s'] } }),
      [
        {
          type: 'moveAction',
          from: { contextId: 'editor', actionId: 'save' },
          to: { contextId: 'files', actionId: 'save' },
        },
      ],
      warn,
    );
    expect(migrated.overrides).toEqual({ files: { save: ['meta+s'] } });
    expect(warn.mock.calls[0]?.[0]).toContain('files.save');
  });

  it('resetOverride clears one key', () => {
    const migrated = applyMigrations(state({ editor: { save: ['meta+s'], undo: ['meta+z'] } }), [
      { type: 'resetOverride', context: 'editor', action: 'save' },
    ]);
    expect(migrated.overrides).toEqual({ editor: { undo: ['meta+z'] } });
  });

  it('renameContext merges with source winning on collision', () => {
    const migrated = applyMigrations(
      state({ old: { save: ['meta+s'] }, new: { save: ['shift+meta+s'], undo: ['meta+z'] } }),
      [{ type: 'renameContext', from: 'old', to: 'new' }],
    );
    expect(migrated.overrides).toEqual({ new: { save: ['meta+s'], undo: ['meta+z'] } });
  });

  it('renameContext is idempotent', () => {
    const migration: ShortcutMigration = { type: 'renameContext', from: 'old', to: 'new' };
    const migrated = applyMigrations(state({ old: { save: ['meta+s'] } }), [migration, migration]);
    expect(migrated.overrides).toEqual({ new: { save: ['meta+s'] } });
  });

  it('custom returns the new state', () => {
    const migrated = applyMigrations(state({}), [
      { type: 'custom', apply: (s) => setBindings(s, 'editor', 'save', ['meta+s']) },
    ]);
    expect(migrated.overrides).toEqual({ editor: { save: ['meta+s'] } });
  });

  it('runs migrations in declaration order', () => {
    const migrated = applyMigrations(state({ editor: { save: ['meta+s'] } }), [
      rename,
      { type: 'renameContext', from: 'editor', to: 'files' },
    ]);
    expect(migrated.overrides).toEqual({ files: { saveFile: ['meta+s'] } });
  });

  it('propagates a throwing migration and leaves the input unchanged', () => {
    const s = state({ editor: { save: ['meta+s'] } });
    const original = JSON.parse(JSON.stringify(s)) as RawState;
    const partial: ShortcutMigration = {
      type: 'custom',
      apply: (current) => {
        setBindings(current, 'partial', 'change', ['meta+p']);
        throw new DemoError('boom');
      },
    };
    expect(() => applyMigrations(s, [rename, partial])).toThrow(DemoError);
    expect(s).toEqual(original);
  });
});

describe('applyMigrationsBestEffort', () => {
  it('skips a throwing migration, reports it and applies the rest', () => {
    const onError = vi.fn<(error: unknown) => void>();
    const migrated = applyMigrationsBestEffort(
      state({ editor: { save: ['meta+s'] } }),
      [throwing, rename],
      onError,
    );
    expect(migrated.overrides).toEqual({ editor: { saveFile: ['meta+s'] } });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(DemoError);
  });
});

describe('registry migrations', () => {
  const editor = defineContext({
    id: 'editor',
    actions: { saveFile: { displayName: 'Save', defaults: 'mod+s' } },
  });

  const logger = () => ({
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  });

  it('migrates loaded state and writes it back', async () => {
    const store = memoryStore({ overrides: { editor: { save: ['ctrl+s'] } } });
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      store,
      migrations: [rename],
      logger: logger(),
    });
    expect(registry.shortcuts(editor, 'saveFile')).toEqual([parseShortcut('ctrl+s', 'mac')]);
    expect(store.current).toEqual(state({ editor: { saveFile: ['ctrl+s'] } }));
  });

  it('applies the remaining migrations at load when one throws', async () => {
    const store = memoryStore({ overrides: { editor: { save: ['ctrl+s'] } } });
    const log = logger();
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      store,
      migrations: [throwing, rename],
      logger: log,
    });
    expect(registry.rawState).toEqual(state({ editor: { saveFile: ['ctrl+s'] } }));
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('reports a failed migration on reload and keeps the current state', async () => {
    const store = memoryStore({ overrides: { editor: { saveFile: ['ctrl+s'] } } });
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      store,
      migrations: [throwing],
      logger: logger(),
    });
    await store.save(state({ editor: { saveFile: ['alt+s'] } }));
    const result = await registry.reload();
    expect(result.type).toBe('migrationFailed');
    expect(registry.rawState).toEqual(state({ editor: { saveFile: ['ctrl+s'] } }));
  });
});
