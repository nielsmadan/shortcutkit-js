// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  defineContext,
  encodeRawState,
  formatShortcut,
  parseShortcut,
  syncRegistry,
  type ApplyResult,
  type RawState,
  type ShortcutRegistry,
  type SyncedShortcutStore,
} from '@shortcutkit/core';
import { localStorageStore } from '../src';

const KEY = 'shortcutkit.state';

const editor = defineContext({
  id: 'editor',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

const sc = (text: string) => parseShortcut(text, 'mac');
const saveTexts = (registry: ShortcutRegistry) =>
  registry.shortcuts(editor, 'save').map(formatShortcut);

const cleanups: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function storageEvent(key: string | null, init: StorageEventInit = {}) {
  window.dispatchEvent(new StorageEvent('storage', { key, ...init }));
}

function listen(store: SyncedShortcutStore) {
  const listener = vi.fn();
  cleanups.push(store.onExternalChange(listener));
  return listener;
}

function newRegistry(store: SyncedShortcutStore) {
  return createRegistry({
    contexts: [editor],
    platform: 'mac',
    logger: { warn: vi.fn(), error: vi.fn() },
    store,
  });
}

function pageshow(persisted: boolean): Event {
  return Object.assign(new Event('pageshow'), { persisted });
}

const overrides = (value: Record<string, Record<string, string[]>>): RawState => ({
  overrides: value,
  preferences: {},
});

describe('localStorageStore', () => {
  it('load resolves to undefined when nothing is stored', async () => {
    await expect(localStorageStore().load()).resolves.toBeUndefined();
  });

  it('save writes sorted JSON under shortcutkit.state', async () => {
    await localStorageStore().save(overrides({ b: { x: ['k'] }, a: { y: ['j'] } }));
    expect(localStorage.getItem(KEY)).toBe('{"overrides":{"a":{"y":["j"]},"b":{"x":["k"]}}}');
  });

  it('load returns what save wrote', async () => {
    const store = localStorageStore();
    await store.save(overrides({ a: { y: ['j'] } }));
    await expect(store.load()).resolves.toEqual({ overrides: { a: { y: ['j'] } } });
  });

  it('uses the configured key and storage', async () => {
    const items = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => void items.set(key, value));
    const store = localStorageStore({
      key: 'custom',
      storage: { getItem: (key) => items.get(key) ?? null, setItem },
    });
    await store.save(overrides({ a: { y: ['j'] } }));
    expect(setItem).toHaveBeenCalledWith('custom', '{"overrides":{"a":{"y":["j"]}}}');
    await expect(store.load()).resolves.toEqual({ overrides: { a: { y: ['j'] } } });
  });

  it('load rejects stored text that is not JSON', async () => {
    localStorage.setItem(KEY, '{nope');
    await expect(localStorageStore().load()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('a registry over corrupted storage logs and starts from defaults', async () => {
    localStorage.setItem(KEY, '{nope');
    const logger = { warn: vi.fn(), error: vi.fn() };
    const registry = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      logger,
      store: localStorageStore(),
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('load failed'));
    expect(saveTexts(registry)).toEqual(['meta+s']);
  });

  it('save rejects when storage throws', async () => {
    const store = localStorageStore({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
    });
    await expect(store.save(overrides({}))).rejects.toThrow('quota');
  });

  it('reads the global localStorage on each call', async () => {
    const store = localStorageStore();
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    await store.save(overrides({ a: { y: ['j'] } }));
    expect(setItem).toHaveBeenCalledWith(KEY, '{"overrides":{"a":{"y":["j"]}}}');
  });
});

describe('localStorageStore onExternalChange', () => {
  it('reports the current stored value when another tab writes', () => {
    const listener = listen(localStorageStore());
    localStorage.setItem(KEY, '{"overrides":{"a":{"y":["j"]}}}');
    storageEvent(KEY);
    expect(listener).toHaveBeenLastCalledWith({ overrides: { a: { y: ['j'] } } });
    localStorage.setItem(KEY, '{"overrides":{"b":{"x":["k"]}}}');
    storageEvent(KEY, { newValue: '{"overrides":{"a":{"y":["j"]}}}' });
    expect(listener).toHaveBeenLastCalledWith({ overrides: { b: { x: ['k'] } } });
  });

  it('reports removal and clear() as undefined', () => {
    const listener = listen(localStorageStore());
    localStorage.setItem(KEY, '{}');
    localStorage.removeItem(KEY);
    storageEvent(KEY);
    storageEvent(null);
    expect(listener.mock.calls).toEqual([[undefined], [undefined]]);
  });

  it('ignores other keys', () => {
    const listener = listen(localStorageStore());
    storageEvent('other');
    expect(listener).not.toHaveBeenCalled();
  });

  it('re-reads on a back/forward cache restore', () => {
    const listener = listen(localStorageStore());
    localStorage.setItem(KEY, '{"a":1}');
    window.dispatchEvent(pageshow(false));
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(pageshow(true));
    expect(listener).toHaveBeenCalledWith({ a: 1 });
  });

  it('skips an unparseable value with a warning', () => {
    const logger = { warn: vi.fn() };
    const listener = listen(localStorageStore({ logger }));
    localStorage.setItem(KEY, '{nope');
    storageEvent(KEY);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ignoring unparseable state'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('words a storage access failure as unreadable, not unparseable', () => {
    const logger = { warn: vi.fn() };
    const store = localStorageStore({
      logger,
      storage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => undefined,
      },
    });
    listen(store);
    storageEvent(KEY);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ignoring unreadable storage'),
    );
  });

  it('stops reporting after unsubscribe', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const listener = vi.fn();
    const stop = localStorageStore({ target }).onExternalChange(listener);
    expect(add.mock.calls.map(([type]) => type)).toEqual(['storage', 'pageshow']);
    stop();
    expect(remove.mock.calls).toEqual(add.mock.calls);
    target.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('syncRegistry over localStorageStore', () => {
  it("applies another tab's edit", async () => {
    const a = await newRegistry(localStorageStore());
    const b = await newRegistry(localStorageStore());
    cleanups.push(syncRegistry(b, localStorageStore()));
    a.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await a.flush();
    storageEvent(KEY);
    expect(saveTexts(b)).toEqual(saveTexts(a));
    expect(saveTexts(b)).toEqual(['ctrl+s']);
  });

  it('a tab with unsaved edits keeps them and its save wins', async () => {
    const a = await newRegistry(localStorageStore());
    const b = await newRegistry(localStorageStore());
    const results: ApplyResult[] = [];
    cleanups.push(syncRegistry(b, localStorageStore(), { onResult: (r) => results.push(r) }));
    a.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await a.flush();
    b.setShortcuts(editor, 'save', [sc('alt+s')]);
    storageEvent(KEY);
    expect(results).toEqual([{ type: 'pendingChanges' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(encodeRawState(b.rawState)));
    expect(saveTexts(b)).toEqual(['alt+s']);
  });

  it('tabs converge when a stale event arrives after a newer save', async () => {
    const a = await newRegistry(localStorageStore());
    const b = await newRegistry(localStorageStore());
    cleanups.push(syncRegistry(a, localStorageStore()), syncRegistry(b, localStorageStore()));
    a.setShortcuts(editor, 'save', [sc('ctrl+s')]);
    await a.flush();
    const aState = a.rawState;
    b.setShortcuts(editor, 'save', [sc('alt+s')]);
    await b.flush();
    storageEvent(KEY, { newValue: JSON.stringify(encodeRawState(aState)) });
    expect(saveTexts(b)).toEqual(['alt+s']);
    expect(saveTexts(a)).toEqual(['alt+s']);
  });
});
