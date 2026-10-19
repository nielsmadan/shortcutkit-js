import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  createRegistry,
  defineContext,
  formatShortcut,
  parseShortcut,
  type RawState,
  type RegistryOptions,
  type SaveResult,
  type ShortcutMigration,
  type ShortcutStore,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    quit: { displayName: 'Quit', defaults: 'mod+q' },
  },
});

const renameSave: ShortcutMigration = {
  type: 'renameAction',
  context: 'editor',
  from: 'save-legacy',
  to: 'save',
};

class StoreError extends Error {}
class MigrationError extends Error {}

interface RecordingStore extends ShortcutStore {
  state: unknown;
  saveCount: number;
  loadCount: number;
  failLoad: boolean;
  failSave: boolean;
}

function recordingStore(state?: unknown): RecordingStore {
  const store: RecordingStore = {
    state,
    saveCount: 0,
    loadCount: 0,
    failLoad: false,
    failSave: false,
    load: () => {
      store.loadCount += 1;
      return store.failLoad ? Promise.reject(new StoreError('load')) : Promise.resolve(store.state);
    },
    save: (next: RawState) => {
      store.saveCount += 1;
      if (store.failSave) return Promise.reject(new StoreError('save'));
      store.state = next;
      return Promise.resolve();
    },
  };
  return store;
}

const sc = (text: string) => parseShortcut(text, 'mac');

function silentLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

function setup(
  store: ShortcutStore,
  options: Partial<Omit<RegistryOptions, 'store'>> = {},
): Promise<ShortcutRegistry> {
  return createRegistry({
    contexts: [editor],
    platform: 'mac',
    logger: silentLogger(),
    ...options,
    store,
  });
}

const saveTexts = (registry: ShortcutRegistry) =>
  registry.shortcuts(editor, 'save').map(formatShortcut);

const overrides = (value: Record<string, Record<string, string[]>>): RawState => ({
  overrides: value,
  preferences: {},
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounced save', () => {
  it('writes after the debounce, not on the mutation', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    expect(store.saveCount).toBe(0);
    expect(registry.hasPendingSave).toBe(true);

    await vi.advanceTimersByTimeAsync(249);
    expect(store.saveCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
    expect(registry.hasPendingSave).toBe(false);
  });

  it('coalesces mutations inside the debounce window into one save', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    await vi.advanceTimersByTimeAsync(200);
    registry.setShortcuts(editor, 'quit', [sc('alt+q')]);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.saveCount).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(store.saveCount).toBe(1);
    expect(store.state).toEqual(overrides({ editor: { save: ['alt+s'], quit: ['alt+q'] } }));
  });

  it('honours saveDebounceMs', async () => {
    const store = recordingStore();
    const registry = await setup(store, { saveDebounceMs: 1000 });
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    await vi.advanceTimersByTimeAsync(999);
    expect(store.saveCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.saveCount).toBe(1);
  });

  it('flush saves immediately and cancels the pending timer', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);

    const result = await registry.flush();

    expect(result).toEqual({
      type: 'saved',
      state: overrides({ editor: { save: ['shift+meta+s'] } }),
    });
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saveCount).toBe(1);
  });

  it('flush with no pending changes resolves undefined and writes nothing', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    expect(await registry.flush()).toBeUndefined();
    expect(store.saveCount).toBe(0);
  });

  it('a failed flush reports the failure and remains retryable', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    store.failSave = true;

    expect(await registry.flush()).toMatchObject({ type: 'failed' });
    expect(store.saveCount).toBe(1);
    expect(registry.hasPendingSave).toBe(true);

    store.failSave = false;
    expect(await registry.flush()).toMatchObject({ type: 'saved' });
    expect(store.saveCount).toBe(2);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));

    expect(await registry.flush()).toBeUndefined();
    expect(store.saveCount).toBe(2);
  });

  it('save results arrive after the store attempt and retain the error', async () => {
    const store = recordingStore();
    const logger = silentLogger();
    const registry = await setup(store, { logger });
    const results: SaveResult[] = [];
    const pending: boolean[] = [];
    registry.onSaveResult((result) => {
      results.push(result);
      pending.push(registry.hasPendingSave);
    });
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    store.failSave = true;

    await registry.flush();
    expect(results).toEqual([
      {
        type: 'failed',
        state: overrides({ editor: { save: ['shift+meta+s'] } }),
        error: expect.any(StoreError),
      },
    ]);
    expect(pending).toEqual([true]);
    expect(logger.error).toHaveBeenCalledWith('save failed: Error: save');

    store.failSave = false;
    await registry.flush();
    expect(results[1]).toEqual({
      type: 'saved',
      state: overrides({ editor: { save: ['shift+meta+s'] } }),
    });
    expect(pending).toEqual([true, false]);
  });

  it('an edit made while a save is in flight stays pending and is saved next', async () => {
    let release: () => void = () => {};
    const saved: RawState[] = [];
    const store: ShortcutStore = {
      load: () => Promise.resolve(undefined),
      save: (state) => {
        saved.push(state);
        return saved.length === 1
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve();
      },
    };
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    const first = registry.flush();
    await vi.advanceTimersByTimeAsync(0);
    registry.setShortcuts(editor, 'quit', [sc('alt+q')]);
    release();
    await first;

    expect(registry.hasPendingSave).toBe(true);
    await registry.flush();
    expect(saved).toEqual([
      overrides({ editor: { save: ['alt+s'] } }),
      overrides({ editor: { save: ['alt+s'], quit: ['alt+q'] } }),
    ]);
    expect(registry.hasPendingSave).toBe(false);
  });
});

describe('initial load', () => {
  it('starts from defaults and logs when the store fails to load', async () => {
    const store = recordingStore();
    store.failLoad = true;
    const logger = silentLogger();
    const registry = await setup(store, { logger });
    expect(saveTexts(registry)).toEqual(['meta+s']);
    expect(logger.error).toHaveBeenCalledWith('load failed: Error: load; starting from defaults');
  });

  it('starts from defaults when the stored shape is malformed', async () => {
    const logger = silentLogger();
    const registry = await setup(recordingStore({ overrides: { editor: { save: 'meta+s' } } }), {
      logger,
    });
    expect(saveTexts(registry)).toEqual(['meta+s']);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('migrates and writes the migrated state back', async () => {
    const store = recordingStore(overrides({ editor: { 'save-legacy': ['shift+meta+s'] } }));
    const registry = await setup(store, { migrations: [renameSave] });
    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
    expect(registry.hasPendingSave).toBe(false);
  });

  it('keeps loaded state and continues after a throwing migration', async () => {
    const store = recordingStore(overrides({ editor: { 'save-legacy': ['shift+meta+s'] } }));
    const logger = silentLogger();
    const registry = await setup(store, {
      logger,
      migrations: [
        {
          type: 'custom',
          apply: () => {
            throw new MigrationError('boom');
          },
        },
        renameSave,
      ],
    });

    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
    expect(registry.hasPendingSave).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('migration failed: Error: boom');
  });

  it('a failed migration write-back remains pending and can be retried', async () => {
    const store = recordingStore(overrides({ editor: { 'save-legacy': ['shift+meta+s'] } }));
    store.failSave = true;
    const registry = await setup(store, { migrations: [renameSave] });

    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(registry.hasPendingSave).toBe(true);
    expect(store.saveCount).toBe(1);

    store.failSave = false;
    expect(await registry.flush()).toMatchObject({ type: 'saved' });
    expect(store.saveCount).toBe(2);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
  });

  it('an unmigrated load writes nothing back', async () => {
    const store = recordingStore(overrides({ editor: { save: ['alt+s'] } }));
    await setup(store, { migrations: [renameSave] });
    expect(store.saveCount).toBe(0);
  });
});

describe('reload', () => {
  it('flushes pending changes instead of discarding them', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);

    expect(await registry.reload()).toEqual({ type: 'reloaded' });
    expect(await registry.flush()).toBeUndefined();
    expect(store.saveCount).toBe(1);
    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
  });

  it('a failed load preserves the local changes', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    store.failLoad = true;

    expect(await registry.reload()).toEqual({
      type: 'loadFailed',
      error: expect.any(StoreError),
    });
    store.failLoad = false;
    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(await registry.flush()).toBeUndefined();
    expect(store.saveCount).toBe(1);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
  });

  it('reports a pending-save failure separately from a load failure', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    store.failSave = true;

    expect(await registry.reload()).toEqual({
      type: 'pendingSaveFailed',
      error: expect.any(StoreError),
    });
    expect(store.loadCount).toBe(1);
    expect(saveTexts(registry)).toEqual(['shift+meta+s']);

    store.failSave = false;
    expect(await registry.flush()).toMatchObject({ type: 'saved' });
    store.failLoad = true;
    expect(await registry.reload()).toEqual({
      type: 'loadFailed',
      error: expect.any(StoreError),
    });
  });

  it('applies out-of-band store changes to bindings and preferences', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    expect(registry.getSnapshot().hintsEnabled).toBe(true);

    store.state = {
      overrides: { editor: { save: ['shift+meta+s'] } },
      preferences: { hintsEnabled: false, hintFrequency: 'always' },
    };
    expect(await registry.reload()).toEqual({ type: 'reloaded' });

    const snapshot = registry.getSnapshot();
    const entry = snapshot.keyBindings.groups[0]?.entries[0];
    expect(entry?.shortcuts.map(formatShortcut)).toEqual(['shift+meta+s']);
    expect(entry?.isCustomized).toBe(true);
    expect(snapshot.hintsEnabled).toBe(false);
    expect(snapshot.hintFrequency).toEqual({ type: 'always' });
  });

  it('publishes the reloaded bindings to subscribers', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    const seen: string[][] = [];
    registry.subscribe(() => {
      seen.push(
        registry.getSnapshot().keyBindings.groups[0]?.entries[0]?.shortcuts.map(formatShortcut) ??
          [],
      );
    });

    store.state = overrides({ editor: { save: ['ctrl+meta+s'] } });
    await registry.reload();

    expect(seen).toEqual([['ctrl+meta+s']]);
  });

  it('applies migrations and writes the migrated state back', async () => {
    const store = recordingStore(overrides({ editor: { 'save-legacy': ['shift+meta+s'] } }));
    const registry = await setup(store, { migrations: [renameSave] });
    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
    store.state = overrides({ editor: { 'save-legacy': ['ctrl+s'] } });

    expect(await registry.reload()).toEqual({ type: 'reloaded' });
    expect(saveTexts(registry)).toEqual(['ctrl+s']);
    expect(store.state).toEqual(overrides({ editor: { save: ['ctrl+s'] } }));
    expect(registry.hasPendingSave).toBe(false);
  });

  it('a throwing migration retains the current runtime state', async () => {
    const store = recordingStore();
    const registry = await setup(store, {
      migrations: [
        {
          type: 'custom',
          apply: (state) => {
            if (state.overrides.invalid) throw new MigrationError();
            return state;
          },
        },
      ],
    });
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    await registry.flush();
    store.state = overrides({ invalid: { value: ['meta+i'] }, editor: { save: ['alt+s'] } });

    expect(await registry.reload()).toEqual({
      type: 'migrationFailed',
      error: expect.any(MigrationError),
    });
    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(registry.hasPendingSave).toBe(false);
  });

  it('applies migrated state while reporting a failed write-back', async () => {
    const store = recordingStore();
    const registry = await setup(store, { migrations: [renameSave] });
    store.state = overrides({ editor: { 'save-legacy': ['ctrl+s'] } });
    store.failSave = true;
    const results: SaveResult[] = [];
    registry.onSaveResult((result) => results.push(result));

    expect(await registry.reload()).toEqual({
      type: 'reloadedWithWritebackFailure',
      error: expect.any(StoreError),
    });
    expect(saveTexts(registry)).toEqual(['ctrl+s']);
    expect(registry.hasPendingSave).toBe(true);
    expect(results.map((result) => result.type)).toEqual(['failed']);

    store.failSave = false;
    expect(await registry.flush()).toMatchObject({ type: 'saved' });
    expect(store.state).toEqual(overrides({ editor: { save: ['ctrl+s'] } }));
  });

  it('an unmigrated reload writes nothing back', async () => {
    const store = recordingStore();
    const registry = await setup(store, { migrations: [renameSave] });
    store.state = overrides({ editor: { save: ['alt+s'] } });
    expect(await registry.reload()).toEqual({ type: 'reloaded' });
    expect(store.saveCount).toBe(0);
    expect(registry.hasPendingSave).toBe(false);
  });

  it('is stale when a local edit lands while the store is read, and the edit wins', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    store.load = () => {
      registry.setShortcuts(editor, 'save', [sc('alt+s')]);
      return Promise.resolve(overrides({ editor: { save: ['ctrl+s'] } }));
    };

    expect(await registry.reload()).toEqual({ type: 'stale' });
    expect(saveTexts(registry)).toEqual(['alt+s']);
    expect(registry.hasPendingSave).toBe(true);
    await registry.flush();
    expect(store.state).toEqual(overrides({ editor: { save: ['alt+s'] } }));
  });
});

describe('applyState', () => {
  it('applies pushed state as one snapshot without writing it back', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    const listener = vi.fn();
    registry.subscribe(listener);

    expect(registry.applyState(overrides({ editor: { save: ['shift+meta+s'] } }))).toEqual({
      type: 'applied',
    });

    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.hasPendingSave).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saveCount).toBe(0);
  });

  it('migrates pushed state and schedules the migrated write-back', async () => {
    const store = recordingStore();
    const registry = await setup(store, { migrations: [renameSave] });

    expect(registry.applyState(overrides({ editor: { 'save-legacy': ['shift+meta+s'] } }))).toEqual(
      { type: 'applied' },
    );

    expect(saveTexts(registry)).toEqual(['shift+meta+s']);
    expect(registry.hasPendingSave).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.state).toEqual(overrides({ editor: { save: ['shift+meta+s'] } }));
  });

  it('is refused while local edits are unsaved, and the local edit is saved', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);

    expect(registry.applyState(overrides({ editor: { save: ['ctrl+s'] } }))).toEqual({
      type: 'pendingChanges',
    });

    expect(saveTexts(registry)).toEqual(['alt+s']);
    await registry.flush();
    expect(store.state).toEqual(overrides({ editor: { save: ['alt+s'] } }));
  });

  it('is refused while a save is in flight', async () => {
    let release: () => void = () => {};
    const store: ShortcutStore = {
      load: () => Promise.resolve(undefined),
      save: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    const saving = registry.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.applyState(overrides({ editor: { save: ['ctrl+s'] } }))).toEqual({
      type: 'pendingChanges',
    });

    release();
    await saving;
    expect(registry.applyState(overrides({ editor: { save: ['ctrl+s'] } }))).toEqual({
      type: 'applied',
    });
    expect(saveTexts(registry)).toEqual(['ctrl+s']);
  });

  it('is accepted again after a failed save is retried successfully', async () => {
    const store = recordingStore();
    const registry = await setup(store);
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    store.failSave = true;
    await registry.flush();
    expect(registry.applyState(overrides({}))).toEqual({ type: 'pendingChanges' });

    store.failSave = false;
    await registry.flush();
    expect(registry.applyState(overrides({}))).toEqual({ type: 'applied' });
    expect(saveTexts(registry)).toEqual(['meta+s']);
  });

  it('rejects a malformed value without applying any part of it', async () => {
    const registry = await setup(recordingStore());
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    await registry.flush();
    const before = registry.getSnapshot();

    const result = registry.applyState({
      overrides: { editor: { save: ['ctrl+s'] }, other: { quit: 'meta+q' } },
    });

    expect(result).toMatchObject({ type: 'invalid' });
    expect(saveTexts(registry)).toEqual(['alt+s']);
    expect(registry.getSnapshot()).toBe(before);
  });

  it('a throwing migration leaves the state untouched', async () => {
    const registry = await setup(recordingStore(), {
      migrations: [
        {
          type: 'custom',
          apply: (state) => {
            if (state.overrides.invalid) throw new MigrationError();
            return state;
          },
        },
      ],
    });
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    await registry.flush();

    expect(
      registry.applyState(overrides({ invalid: { x: ['meta+i'] }, editor: { save: ['ctrl+s'] } })),
    ).toEqual({ type: 'migrationFailed', error: expect.any(MigrationError) });

    expect(saveTexts(registry)).toEqual(['alt+s']);
    expect(registry.hasPendingSave).toBe(false);
  });

  it('applies pushed preferences', async () => {
    const registry = await setup(recordingStore());
    registry.applyState({ overrides: {}, preferences: { hintsEnabled: false } });
    expect(registry.getSnapshot().hintsEnabled).toBe(false);
  });
});
