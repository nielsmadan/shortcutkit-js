// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseShortcut, shortcutLabel, usLayout } from '@shortcutkit/core';
import { keyboardLayoutProvider, systemLayoutMap } from '../src';

type LayoutMap = ReadonlyMap<string, string> | undefined;

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function track(unsubscribe: () => void): () => void {
  cleanups.push(unsubscribe);
  return unsubscribe;
}

function deferred() {
  let resolve!: (value: LayoutMap) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<LayoutMap>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(...loads: ReturnType<typeof deferred>[]) {
  const queue = [...loads];
  const load = vi.fn(() => queue.shift()?.promise ?? Promise.resolve(undefined));
  const logger = { warn: vi.fn() };
  const provider = keyboardLayoutProvider({ load, logger });
  const notified: (() => void)[] = [];
  const unsubscribe = track(provider.subscribe(() => notified.splice(0).forEach((next) => next())));
  const nextNotification = () => new Promise<void>((resolve) => notified.push(resolve));
  return { load, logger, provider, unsubscribe, nextNotification };
}

describe('keyboardLayoutProvider', () => {
  it('starts with the US layout', () => {
    expect(keyboardLayoutProvider({ load: vi.fn() }).getSnapshot()).toBe(usLayout);
  });

  it('looks up the layout when the first listener subscribes', async () => {
    const first = deferred();
    const { load, provider, nextNotification } = setup(first);
    expect(load).toHaveBeenCalledTimes(1);
    const notified = nextNotification();
    first.resolve(new Map([['KeyQ', 'a']]));
    await notified;
    expect(provider.getSnapshot()('KeyQ')).toBe('a');
  });

  it('labels shortcuts with the loaded layout', async () => {
    const first = deferred();
    const { provider, nextNotification } = setup(first);
    const notified = nextNotification();
    first.resolve(new Map([['KeyQ', 'a']]));
    await notified;
    expect(
      shortcutLabel(parseShortcut('q', 'windows'), {
        platform: 'windows',
        layout: provider.getSnapshot(),
      }),
    ).toBe('A');
  });

  it('keeps the same snapshot when the layout is unchanged', async () => {
    const [first, second] = [deferred(), deferred()];
    const { provider, nextNotification } = setup(first, second);
    const listener = vi.fn();
    track(provider.subscribe(listener));
    const notified = nextNotification();
    first.resolve(new Map([['KeyQ', 'a']]));
    await notified;
    const snapshot = provider.getSnapshot();
    const refreshed = provider.refresh();
    second.resolve(new Map([['KeyQ', 'a']]));
    await refreshed;
    expect(provider.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the window regains focus', async () => {
    const [first, second] = [deferred(), deferred()];
    const { load, provider, nextNotification } = setup(first, second);
    let notified = nextNotification();
    first.resolve(new Map([['KeyQ', 'a']]));
    await notified;
    notified = nextNotification();
    window.dispatchEvent(new Event('focus'));
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve(new Map([['KeyQ', 'b']]));
    await notified;
    expect(provider.getSnapshot()('KeyQ')).toBe('b');
  });

  it('stops refreshing on focus after the last unsubscribe', () => {
    const first = deferred();
    const { load, unsubscribe } = setup(first);
    unsubscribe();
    unsubscribe();
    window.dispatchEvent(new Event('focus'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('adds and removes a matching focus listener on the target', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const provider = keyboardLayoutProvider({ load: () => Promise.resolve(undefined), target });
    const unsubscribe = track(provider.subscribe(() => undefined));
    expect(add.mock.calls).toEqual([['focus', expect.any(Function)]]);
    unsubscribe();
    expect(remove.mock.calls).toEqual(add.mock.calls);
  });

  it('keeps the focus listener while another subscriber remains', () => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, 'removeEventListener');
    const provider = keyboardLayoutProvider({ load: () => Promise.resolve(undefined), target });
    const leaving = track(provider.subscribe(() => undefined));
    const staying = track(provider.subscribe(() => undefined));
    leaving();
    expect(remove).not.toHaveBeenCalled();
    staying();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('adds one focus listener when the same listener subscribes twice', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const load = vi.fn(() => Promise.resolve(undefined));
    const provider = keyboardLayoutProvider({ load, target });
    const listener = () => undefined;
    const first = track(provider.subscribe(listener));
    const second = track(provider.subscribe(listener));
    first();
    second();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls).toEqual(add.mock.calls);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous layout and warns once when a later lookup fails', async () => {
    const logger = { warn: vi.fn() };
    const loads: (() => Promise<LayoutMap>)[] = [
      () => Promise.resolve(new Map([['KeyQ', 'a']])),
      () => Promise.reject(new Error('boom')),
      () => Promise.reject(new Error('boom')),
    ];
    const provider = keyboardLayoutProvider({
      load: () => loads.shift()?.() ?? Promise.resolve(undefined),
      logger,
    });
    track(provider.subscribe(() => undefined));
    await vi.waitFor(() => expect(provider.getSnapshot()('KeyQ')).toBe('a'));
    const loaded = provider.getSnapshot();
    await provider.refresh();
    await provider.refresh();
    expect(provider.getSnapshot()).toBe(loaded);
    expect(provider.getSnapshot()('KeyQ')).toBe('a');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keyboard layout'));
  });

  it('warns about the current lookup when a superseded one failed first', async () => {
    const [first, second] = [deferred(), deferred()];
    const { logger, provider } = setup(first, second);
    const refreshed = provider.refresh();
    first.reject(new Error('stale'));
    second.reject(new Error('current'));
    await refreshed;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('current'));
  });

  it('drops keys the refreshed layout no longer has', async () => {
    const [first, second] = [deferred(), deferred()];
    const { provider, nextNotification } = setup(first, second);
    const notified = nextNotification();
    first.resolve(
      new Map([
        ['KeyQ', 'a'],
        ['KeyW', 'z'],
      ]),
    );
    await notified;
    const refreshed = provider.refresh();
    second.resolve(new Map([['KeyQ', 'a']]));
    await refreshed;
    expect(provider.getSnapshot()('KeyW')).toBeUndefined();
    expect(provider.getSnapshot()('KeyQ')).toBe('a');
  });

  it('notifies the remaining listeners and rethrows when a listener throws', async () => {
    const queued: (() => void)[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      queued.push(callback);
    });
    const provider = keyboardLayoutProvider({
      load: () => Promise.resolve(new Map([['KeyQ', 'a']])),
    });
    track(
      provider.subscribe(() => {
        throw new Error('listener');
      }),
    );
    const next = vi.fn();
    track(provider.subscribe(next));
    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow('listener');
  });

  it('applies only the latest of overlapping lookups', async () => {
    const [first, second] = [deferred(), deferred()];
    const { load, provider, nextNotification } = setup(first, second);
    const notified = nextNotification();
    const overlapping = provider.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve(new Map([['KeyQ', 'second']]));
    await notified;
    first.resolve(new Map([['KeyQ', 'first']]));
    await overlapping;
    expect(provider.getSnapshot()('KeyQ')).toBe('second');
  });

  it('returns to the US layout when the lookup reports none', async () => {
    const [first, second] = [deferred(), deferred()];
    const { provider, nextNotification } = setup(first, second);
    let notified = nextNotification();
    first.resolve(new Map([['KeyQ', 'a']]));
    await notified;
    notified = nextNotification();
    const refreshed = provider.refresh();
    second.resolve(undefined);
    await notified;
    await refreshed;
    expect(provider.getSnapshot()).toBe(usLayout);
  });
});

describe('systemLayoutMap', () => {
  it('is undefined without navigator.keyboard', async () => {
    vi.stubGlobal('navigator', {});
    expect(await systemLayoutMap()).toBeUndefined();
  });

  it('calls getLayoutMap on navigator.keyboard', async () => {
    const stub = {
      getLayoutMap: function (this: unknown) {
        if (this !== stub) throw new TypeError('Illegal invocation');
        return Promise.resolve(new Map([['KeyA', 'q']]));
      },
    };
    vi.stubGlobal('navigator', { keyboard: stub });
    expect((await systemLayoutMap())?.get('KeyA')).toBe('q');
  });
});
