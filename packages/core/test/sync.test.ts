import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  defineContext,
  encodeRawState,
  formatShortcut,
  modifiers,
  parseShortcut,
  syncRegistry,
  type ApplyResult,
  type RawState,
  type ShortcutRegistry,
  type SyncedShortcutStore,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

const list = defineContext({
  id: 'list',
  actions: { goToTop: { displayName: 'Go to top', defaults: 'g g' } },
});

interface FakeStore extends SyncedShortcutStore {
  state: unknown;
  failNextSave: boolean;
  listeners: ((state: unknown) => void)[];
  emit(value: unknown): void;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    state: undefined,
    failNextSave: false,
    listeners: [],
    load: () => Promise.resolve(store.state),
    save: (next: RawState) => {
      if (store.failNextSave) {
        store.failNextSave = false;
        return Promise.reject(new Error('save'));
      }
      store.state = next;
      return Promise.resolve();
    },
    onExternalChange: (listener) => {
      store.listeners.push(listener);
      return () => {
        store.listeners.splice(store.listeners.indexOf(listener), 1);
      };
    },
    emit: (value) => {
      store.listeners.slice().forEach((listener) => {
        listener(value);
      });
    },
  };
  return store;
}

const sc = (text: string) => parseShortcut(text, 'mac');
const quiet = () => ({ warn: vi.fn(), error: vi.fn() });

async function setup(contexts: Parameters<typeof createRegistry>[0]['contexts'] = [editor]) {
  const store = fakeStore();
  const registry: ShortcutRegistry = await createRegistry({
    contexts,
    platform: 'mac',
    logger: quiet(),
    store,
  });
  const results: ApplyResult[] = [];
  const logger = quiet();
  const stop = syncRegistry(registry, store, {
    onResult: (result) => results.push(result),
    logger,
  });
  return { store, registry, results, logger, stop };
}

const key = (code: string) => ({ type: 'key', code, modifiers: modifiers([]) }) as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('syncRegistry', () => {
  it('applies state the store reports', async () => {
    const { store, registry, results, logger } = await setup();
    store.emit({ overrides: { editor: { save: ['alt+s'] } } });
    expect(registry.shortcuts(editor, 'save').map(formatShortcut)).toEqual(['alt+s']);
    expect(results).toEqual([{ type: 'applied' }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips state equal to the registry's own", async () => {
    const { store, registry, results } = await setup([editor, list]);
    registry.activate(list, () => undefined);
    expect(registry.handleInput(key('KeyG'))).toBe('advanced');
    store.emit(JSON.parse(JSON.stringify(encodeRawState(registry.rawState))));
    expect(results).toEqual([]);
    expect(registry.handleInput(key('KeyG'))).toBe('fired');
  });

  it('leaves a refused state to the pending local save', async () => {
    const { store, registry, results, logger } = await setup();
    registry.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    store.emit({ overrides: { editor: { save: ['alt+s'] } } });
    expect(results).toEqual([{ type: 'pendingChanges' }]);
    expect(logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.state).toEqual({ overrides: { editor: { save: ['ctrl+s'] } }, preferences: {} });
  });

  it("retries a failed save when another window's state arrives", async () => {
    const { store, registry, results } = await setup();
    store.failNextSave = true;
    registry.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await registry.flush();
    expect(store.state).toBeUndefined();
    store.emit({ overrides: { editor: { save: ['alt+s'] } } });
    expect(results).toEqual([{ type: 'pendingChanges' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.state).toEqual({ overrides: { editor: { save: ['ctrl+s'] } }, preferences: {} });
  });

  it('warns about invalid external state', async () => {
    const { store, logger, results } = await setup();
    store.emit({ overrides: 'x' });
    expect(results).toEqual([{ type: 'invalid', error: expect.anything() as unknown }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  it('warns about external state whose migration fails', async () => {
    const store = fakeStore();
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      logger: quiet(),
      store,
      migrations: [
        {
          type: 'custom',
          apply: (state) => {
            if (state.overrides['editor']) throw new Error('bad');
            return state;
          },
        },
      ],
    });
    const results: ApplyResult[] = [];
    const logger = quiet();
    syncRegistry(registry, store, { onResult: (result) => results.push(result), logger });
    store.emit({ overrides: { editor: { save: ['alt+s'] } } });
    expect(results).toEqual([{ type: 'migrationFailed', error: expect.anything() as unknown }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('migrationFailed'));
  });

  it('warns through the console by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = fakeStore();
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      logger: quiet(),
      store,
    });
    syncRegistry(registry, store);
    store.emit({ overrides: 'x' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[shortcutkit] external state ignored (invalid)'),
    );
  });

  it('the returned function unsubscribes from the store', async () => {
    const { store, stop } = await setup();
    expect(store.listeners).toHaveLength(1);
    stop();
    expect(store.listeners).toHaveLength(0);
  });
});
