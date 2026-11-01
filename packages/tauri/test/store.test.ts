import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  decodeRawState,
  defineContext,
  encodeRawState,
  formatShortcut,
  parseShortcut,
  syncRegistry,
  type RawState,
  type ShortcutRegistry,
  type SyncedShortcutStore,
} from '@shortcutkit/core';
import { tauriStore, type TauriIpc } from '../guest-js';
import { initialSyncState, stepSync } from '../guest-js/store-sync';

const FILE = 'shortcuts.json';

interface Delivery {
  readonly window: string;
  readonly kind: 'response' | 'event' | 'listen';
  readonly name: string;
  readonly run: () => void;
}

interface Handler {
  readonly window: string;
  readonly event: string;
  readonly handler: (payload: unknown) => void;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeBackend() {
  const files = new Map<string, { readonly revision: number; readonly state: unknown }>();
  const queue: Delivery[] = [];
  const handlers = new Set<Handler>();
  const failNext = new Set<string>();
  const calls: { readonly window: string; readonly command: string; readonly args: unknown }[] = [];

  const snapshot = (file: string) => ({
    revision: files.get(file)?.revision ?? 0,
    state: files.get(file)?.state ?? null,
  });

  const write = (file: string, state: unknown): number => {
    const revision = (files.get(file)?.revision ?? 0) + 1;
    files.set(file, { revision, state: structuredClone(state) });
    [...handlers]
      .filter((entry) => entry.event === 'shortcutkit://state')
      .forEach((entry) =>
        queue.push({
          window: entry.window,
          kind: 'event',
          name: `${file}@${revision}`,
          run: () => {
            if (handlers.has(entry)) entry.handler({ file, revision });
          },
        }),
      );
    return revision;
  };

  const ipc = (window: string): TauriIpc => ({
    invoke<T>(command: string, args: Record<string, unknown> = {}) {
      calls.push({ window, command, args });
      const name = command.replace('plugin:shortcutkit|', '');
      return new Promise<T>((resolve, reject) => {
        if (failNext.delete(name)) {
          queue.push({ window, kind: 'response', name, run: () => reject(new Error(`${name}`)) });
          return;
        }
        const file = args['file'] as string;
        const result =
          name === 'load_state' ? snapshot(file) : { revision: write(file, args['state']) };
        queue.push({ window, kind: 'response', name, run: () => resolve(result as T) });
      });
    },
    listen<T>(event: string, handler: (payload: T) => void) {
      const entry: Handler = { window, event, handler: handler as (payload: unknown) => void };
      handlers.add(entry);
      return new Promise<() => void>((resolve) =>
        queue.push({
          window,
          kind: 'listen',
          name: event,
          run: () => resolve(() => handlers.delete(entry)),
        }),
      );
    },
  });

  const release = async (match: Partial<Omit<Delivery, 'run'>>) => {
    await tick();
    const index = queue.findIndex((delivery) =>
      Object.entries(match).every(([key, value]) => delivery[key as keyof Delivery] === value),
    );
    if (index < 0) throw new Error(`no ${JSON.stringify(match)} in ${pending().join(', ')}`);
    queue.splice(index, 1)[0]?.run();
    await tick();
  };

  const drain = async (pick: (length: number) => number = () => 0) => {
    await tick();
    while (queue.length > 0) {
      queue.splice(pick(queue.length), 1)[0]?.run();
      await tick();
    }
  };

  const releaseSome = async (pick: (length: number) => number, count: number) => {
    for (let released = 0; released < count; released += 1) {
      await tick();
      if (queue.length === 0) return;
      queue.splice(pick(queue.length), 1)[0]?.run();
    }
    await tick();
  };

  const pending = () => queue.map((d) => `${d.window} ${d.kind} ${d.name}`);

  return {
    ipc,
    write,
    release,
    drain,
    releaseSome,
    pending,
    calls,
    failNext: (command: string) => failNext.add(command),
    content: (file = FILE) => files.get(file)?.state,
    listenerCount: () => handlers.size,
  };
}

type Backend = ReturnType<typeof fakeBackend>;

const overrides = (shortcut: string): RawState => ({
  overrides: { editor: { save: [shortcut] } },
  preferences: {},
});
const encoded = (shortcut: string) => encodeRawState(overrides(shortcut));

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function subscribe(store: SyncedShortcutStore) {
  const listener = vi.fn();
  cleanups.push(store.onExternalChange(listener));
  return listener;
}

async function subscribed(backend: Backend, window = 'a') {
  const store = tauriStore({ ipc: backend.ipc(window), logger: { warn: vi.fn() } });
  const listener = subscribe(store);
  await backend.drain();
  return { store, listener };
}

describe('tauriStore load and save', () => {
  it('load maps a missing file to undefined', async () => {
    const backend = fakeBackend();
    const loaded = tauriStore({ ipc: backend.ipc('a') }).load();
    await backend.drain();
    await expect(loaded).resolves.toBeUndefined();
  });

  it('load resolves to the stored state', async () => {
    const backend = fakeBackend();
    backend.write(FILE, encoded('ctrl+s'));
    const loaded = tauriStore({ ipc: backend.ipc('a') }).load();
    await backend.drain();
    await expect(loaded).resolves.toEqual(encoded('ctrl+s'));
  });

  it('save sends the encoded state for its file', async () => {
    const backend = fakeBackend();
    const saved = tauriStore({ ipc: backend.ipc('a'), file: 'other.json' }).save(
      overrides('ctrl+s'),
    );
    await backend.drain();
    await saved;
    expect(backend.calls).toEqual([
      {
        window: 'a',
        command: 'plugin:shortcutkit|save_state',
        args: { file: 'other.json', state: encoded('ctrl+s') },
      },
    ]);
  });

  it('save rejects when the backend fails', async () => {
    const backend = fakeBackend();
    backend.failNext('save_state');
    const saved = tauriStore({ ipc: backend.ipc('a') }).save(overrides('ctrl+s'));
    const outcome = expect(saved).rejects.toThrow('save_state');
    await backend.drain();
    await outcome;
  });

  it('load racing an event returns the newest state', async () => {
    const backend = fakeBackend();
    const { store } = await subscribed(backend);
    backend.write(FILE, encoded('ctrl+s'));
    const loaded = store.load();
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    await backend.release({ kind: 'event', name: `${FILE}@2` });
    await backend.drain();
    await expect(loaded).resolves.toEqual(encoded('alt+s'));
  });
});

describe('tauriStore onExternalChange', () => {
  it('re-reads and reports on an event with a higher revision', async () => {
    const backend = fakeBackend();
    const { listener } = await subscribed(backend);
    backend.write(FILE, encoded('ctrl+s'));
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('ctrl+s')]]);
  });

  it('does not report an event at or below the loaded revision', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    backend.write(FILE, encoded('ctrl+s'));
    const loaded = store.load();
    await backend.release({ kind: 'response', name: 'load_state' });
    await expect(loaded).resolves.toEqual(encoded('ctrl+s'));
    await backend.drain();
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores another file's event", async () => {
    const backend = fakeBackend();
    const { listener } = await subscribed(backend);
    backend.write('other.json', encoded('ctrl+s'));
    await backend.drain();
    expect(listener).not.toHaveBeenCalled();
    expect(backend.calls.map(({ command }) => command)).toEqual(['plugin:shortcutkit|load_state']);
  });

  it('reports an event during a save only after the save resolves', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    const saved = store.save(overrides('ctrl+s'));
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    await backend.release({ kind: 'event', name: `${FILE}@2` });
    expect(backend.pending()).toEqual(['a response save_state']);
    await backend.drain();
    await saved;
    expect(listener.mock.calls).toEqual([[encoded('alt+s')]]);
  });

  it('reports an event during a save only after the save rejects', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    backend.failNext('save_state');
    const saved = store.save(overrides('ctrl+s')).catch(() => 'rejected');
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    expect(backend.pending()).toEqual(['a response save_state']);
    await backend.drain();
    await expect(saved).resolves.toBe('rejected');
    expect(listener.mock.calls).toEqual([[encoded('alt+s')]]);
  });

  it("drops an event below the save's own revision", async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    backend.write(FILE, encoded('alt+s'));
    const saved = store.save(overrides('ctrl+s'));
    await backend.release({ kind: 'response', name: 'save_state' });
    await saved;
    await backend.drain();
    expect(listener).not.toHaveBeenCalled();
    expect(backend.calls.filter(({ command }) => command.endsWith('load_state'))).toHaveLength(1);
  });

  it('reports two events during one save once, with the highest revision', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    const saved = store.save(overrides('ctrl+s'));
    backend.write(FILE, encoded('alt+s'));
    backend.write(FILE, encoded('shift+s'));
    await backend.release({ kind: 'event', name: `${FILE}@2` });
    await backend.release({ kind: 'event', name: `${FILE}@3` });
    await backend.drain();
    await saved;
    expect(listener.mock.calls).toEqual([[encoded('shift+s')]]);
  });

  it('never lets a re-read older than the save overwrite it', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    expect(backend.pending()).toEqual(['a response load_state']);
    const saved = store.save(overrides('ctrl+s'));
    await backend.release({ kind: 'response', name: 'save_state' });
    await saved;
    backend.write(FILE, encoded('shift+s'));
    await backend.release({ kind: 'response', name: 'load_state' });
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('shift+s')]]);
  });

  it('re-reads after a stale read when newer events arrived meanwhile', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    const saved = store.save(overrides('ctrl+s'));
    await backend.release({ kind: 'response', name: 'save_state' });
    await saved;
    backend.write(FILE, encoded('shift+s'));
    await backend.release({ kind: 'event', name: `${FILE}@2` });
    await backend.release({ kind: 'event', name: `${FILE}@3` });
    await backend.release({ kind: 'response', name: 'load_state' });
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('shift+s')]]);
  });

  it('starts one follow-up read for events that arrive during a read', async () => {
    const backend = fakeBackend();
    await subscribed(backend);
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    backend.write(FILE, encoded('ctrl+s'));
    backend.write(FILE, encoded('shift+s'));
    await backend.release({ kind: 'event', name: `${FILE}@2` });
    await backend.release({ kind: 'event', name: `${FILE}@3` });
    expect(backend.pending()).toEqual(['a response load_state']);
  });

  it('holds back a re-read that resolves while a save is in flight', async () => {
    const backend = fakeBackend();
    const { store, listener } = await subscribed(backend);
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    const saved = store.save(overrides('ctrl+s'));
    await backend.release({ kind: 'response', name: 'load_state' });
    await backend.drain();
    await saved;
    backend.write(FILE, encoded('shift+s'));
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('shift+s')]]);
  });

  it('probes after subscribing and reports a write it missed', async () => {
    const backend = fakeBackend();
    const store = tauriStore({ ipc: backend.ipc('a') });
    const loaded = store.load();
    await backend.drain();
    await loaded;
    backend.write(FILE, encoded('ctrl+s'));
    const listener = subscribe(store);
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('ctrl+s')]]);
  });

  it('defers the probe while a save is in flight', async () => {
    const backend = fakeBackend();
    const store = tauriStore({ ipc: backend.ipc('a'), logger: { warn: vi.fn() } });
    backend.write(FILE, encoded('alt+s'));
    const listener = subscribe(store);
    await backend.release({ kind: 'listen' });
    backend.failNext('save_state');
    const saved = store.save(overrides('ctrl+s')).catch(() => 'rejected');
    await backend.release({ kind: 'response', name: 'load_state' });
    expect(backend.pending()).toEqual(['a response save_state']);
    await backend.drain();
    await saved;
    expect(listener.mock.calls).toEqual([[encoded('alt+s')]]);
  });

  it('warns on a failed re-read and retries on the next event', async () => {
    const backend = fakeBackend();
    const logger = { warn: vi.fn() };
    const store = tauriStore({ ipc: backend.ipc('a'), logger });
    const listener = subscribe(store);
    await backend.drain();
    backend.failNext('load_state');
    backend.write(FILE, encoded('ctrl+s'));
    await backend.drain();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('re-reading "shortcuts.json"'),
    );
    backend.write(FILE, encoded('alt+s'));
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('alt+s')]]);
  });

  it('teardown before listen resolves leaves no listener', async () => {
    const backend = fakeBackend();
    const store = tauriStore({ ipc: backend.ipc('a') });
    const stop = store.onExternalChange(vi.fn());
    stop();
    await backend.drain();
    expect(backend.listenerCount()).toBe(0);
    expect(backend.calls).toEqual([]);
  });

  it('unlistens when the last listener unsubscribes', async () => {
    const backend = fakeBackend();
    const store = tauriStore({ ipc: backend.ipc('a') });
    const stop = store.onExternalChange(vi.fn());
    await backend.drain();
    expect(backend.listenerCount()).toBe(1);
    stop();
    expect(backend.listenerCount()).toBe(0);
  });

  it('stops re-reading once the last listener unsubscribes mid-save', async () => {
    const backend = fakeBackend();
    const { store } = await subscribed(backend);
    const stop = cleanups.pop();
    const saved = store.save(overrides('ctrl+s'));
    backend.write(FILE, encoded('alt+s'));
    await backend.release({ kind: 'event', name: `${FILE}@2` });
    stop?.();
    await backend.drain();
    await saved;
    expect(backend.calls.map(({ command }) => command)).toEqual([
      'plugin:shortcutkit|load_state',
      'plugin:shortcutkit|save_state',
    ]);
  });

  it('reports to a later listener a state re-read while nobody listened', async () => {
    const backend = fakeBackend();
    const { store } = await subscribed(backend);
    const stop = cleanups.pop();
    backend.write(FILE, encoded('ctrl+s'));
    await backend.release({ kind: 'event', name: `${FILE}@1` });
    stop?.();
    await backend.drain();
    const listener = subscribe(store);
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('ctrl+s')]]);
  });
});

describe('tauriStore failure paths', () => {
  it('reports to the other listeners and rethrows asynchronously when one throws', async () => {
    const backend = fakeBackend();
    const rethrown: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (callback: () => void) => rethrown.push(callback));
    cleanups.push(() => vi.unstubAllGlobals());
    const store = tauriStore({ ipc: backend.ipc('a') });
    const error = new Error('listener failed');
    cleanups.push(
      store.onExternalChange(() => {
        throw error;
      }),
    );
    const listener = subscribe(store);
    await backend.drain();
    backend.write(FILE, encoded('ctrl+s'));
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('ctrl+s')]]);
    expect(rethrown).toHaveLength(1);
    expect(() => rethrown[0]?.()).toThrow(error);
  });

  it('warns and does not probe when listen rejects', async () => {
    const backend = fakeBackend();
    const warn = vi.fn();
    const ipc: TauriIpc = {
      ...backend.ipc('a'),
      listen: () => Promise.reject(new Error('denied')),
    };
    const store = tauriStore({ ipc, logger: { warn } });
    subscribe(store);
    await backend.drain();
    expect(warn.mock.calls).toEqual([
      ['listening for "shortcuts.json" changes failed: Error: denied'],
    ]);
    expect(backend.calls).toEqual([]);
  });

  it('warns when listen throws synchronously', async () => {
    const backend = fakeBackend();
    const warn = vi.fn();
    const ipc: TauriIpc = {
      ...backend.ipc('a'),
      listen: () => {
        throw new Error('no webview');
      },
    };
    subscribe(tauriStore({ ipc, logger: { warn } }));
    await backend.drain();
    expect(warn.mock.calls).toEqual([
      ['listening for "shortcuts.json" changes failed: Error: no webview'],
    ]);
  });

  it('warns on a failed probe and still reports the next event', async () => {
    const backend = fakeBackend();
    const warn = vi.fn();
    const store = tauriStore({ ipc: backend.ipc('a'), logger: { warn } });
    backend.failNext('load_state');
    const listener = subscribe(store);
    await backend.drain();
    expect(warn.mock.calls).toEqual([
      ['reading "shortcuts.json" after subscribing failed: Error: load_state'],
    ]);
    backend.write(FILE, encoded('ctrl+s'));
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('ctrl+s')]]);
  });

  it('rejects a save whose invoke throws synchronously and keeps reporting events', async () => {
    const backend = fakeBackend();
    const base = backend.ipc('a');
    const ipc: TauriIpc = {
      ...base,
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        if (command.endsWith('save_state')) throw new Error('no ipc');
        return base.invoke<T>(command, args);
      },
    };
    const store = tauriStore({ ipc, logger: { warn: vi.fn() } });
    const listener = subscribe(store);
    await backend.drain();
    await expect(store.save(overrides('ctrl+s'))).rejects.toThrow('no ipc');
    backend.write(FILE, encoded('alt+s'));
    await backend.drain();
    expect(listener.mock.calls).toEqual([[encoded('alt+s')]]);
  });
});

const editor = defineContext({
  id: 'editor',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

const sc = (text: string) => parseShortcut(text, 'mac');
const saveTexts = (registry: ShortcutRegistry) =>
  registry.shortcuts(editor, 'save').map(formatShortcut);

async function openWindow(backend: Backend, name: string) {
  const store = tauriStore({ ipc: backend.ipc(name), logger: { warn: vi.fn() } });
  const created = createRegistry({
    contexts: [editor],
    platform: 'mac',
    logger: { warn: vi.fn(), error: vi.fn() },
    saveDebounceMs: 0,
    store,
  });
  await backend.drain();
  const registry = await created;
  return { registry, store };
}

function seeded(seed: number) {
  let value = seed;
  return (length: number) => {
    value = (Math.imul(value, 1103515245) + 12345) >>> 0;
    return (value >>> 16) % length;
  };
}

function expectConverged(backend: Backend, registries: readonly ShortcutRegistry[]) {
  const file = decodeRawState(backend.content());
  registries.forEach((registry) => expect(registry.rawState).toEqual(file));
}

describe('syncRegistry over tauriStore', () => {
  it("applies another window's save", async () => {
    const backend = fakeBackend();
    const a = await openWindow(backend, 'a');
    const b = await openWindow(backend, 'b');
    cleanups.push(syncRegistry(b.registry, b.store));
    await backend.drain();
    a.registry.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await backend.drain();
    expect(saveTexts(b.registry)).toEqual(['ctrl+s']);
  });

  it('catches up with a write between load and subscribing', async () => {
    const backend = fakeBackend();
    const a = await openWindow(backend, 'a');
    const b = await openWindow(backend, 'b');
    cleanups.push(syncRegistry(a.registry, a.store));
    await backend.drain();
    a.registry.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await backend.drain();
    cleanups.push(syncRegistry(b.registry, b.store));
    await backend.drain();
    expect(saveTexts(b.registry)).toEqual(['ctrl+s']);
    expectConverged(backend, [a.registry, b.registry]);
  });

  it('catches up with a write that lands while its own save is in flight', async () => {
    const backend = fakeBackend();
    const a = await openWindow(backend, 'a');
    const b = await openWindow(backend, 'b');
    cleanups.push(syncRegistry(a.registry, a.store), syncRegistry(b.registry, b.store));
    await backend.drain();
    b.registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    await tick();
    a.registry.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await tick();
    expect(backend.pending()).toEqual([
      'a event shortcuts.json@1',
      'b event shortcuts.json@1',
      'b response save_state',
      'a event shortcuts.json@2',
      'b event shortcuts.json@2',
      'a response save_state',
    ]);
    await backend.release({ window: 'b', kind: 'event', name: `${FILE}@2` });
    await backend.drain();
    expect(saveTexts(b.registry)).toEqual(['ctrl+s']);
    expectConverged(backend, [a.registry, b.registry]);
  });

  it.each([2, 3])('%i windows converge under interleaved saves', async (count) => {
    const shortcuts = ['ctrl+s', 'alt+s', 'shift+s', 'ctrl+alt+s', 'meta+shift+s'];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const backend = fakeBackend();
      const windows = await Promise.all(
        Array.from({ length: count }, (_, i) => openWindow(backend, String(i))),
      );
      windows.forEach(({ registry, store }) => cleanups.push(syncRegistry(registry, store)));
      await backend.drain();
      const pick = seeded(seed);
      for (const [i, shortcut] of shortcuts.entries()) {
        windows[(i + seed) % count]?.registry.setShortcuts(editor, 'save', [sc(shortcut)]);
        await backend.releaseSome(pick, i % 3);
      }
      await backend.drain(pick);
      expectConverged(
        backend,
        windows.map(({ registry }) => registry),
      );
    }
  });
});

describe('stepSync', () => {
  it('raises seen from a read that resolves while a save is in flight', () => {
    const state = {
      ...initialSyncState,
      known: 1,
      seen: 1,
      saving: 1,
      reading: true,
      listeners: 1,
    };
    const step = stepSync(state, { type: 'readResolved', revision: 3, state: null });
    expect(step.state.seen).toBe(3);
  });
});
