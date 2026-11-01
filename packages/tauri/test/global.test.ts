// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  defineContext,
  memoryStore,
  parseShortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { createShortcutRecorder } from '@shortcutkit/dom';
import {
  attachGlobalHotkeys,
  bindingKeyString,
  type AttachGlobalHotkeysOptions,
  type TauriIpc,
} from '../guest-js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const app = defineContext({
  id: 'app',
  scope: 'global',
  actions: {
    show: { displayName: 'Show', defaults: 'ctrl+alt+meta+k' },
    hide: { displayName: 'Hide', defaults: ['ctrl+alt+meta+h', 'g g'] },
  },
});

const SHOW = { contextId: 'app', actionId: 'show', bindingIndex: 0 };
const HIDE = { contextId: 'app', actionId: 'hide', bindingIndex: 0 };
const HIDE_SEQUENCE = { contextId: 'app', actionId: 'hide', bindingIndex: 1 };
const MODS = { ctrl: true, alt: true, shift: false, meta: true };
const KEY_K = { code: 'KeyK', modifiers: MODS };
const KEY_H = { code: 'KeyH', modifiers: MODS };
const KEY_J = { code: 'KeyJ', modifiers: MODS };

interface Invoke {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface Registration {
  readonly id: typeof SHOW;
  readonly key: { readonly code: string; readonly modifiers: typeof MODS };
  readonly result: 'registered' | 'failed';
  readonly error?: string;
}

function globalState(
  version: number,
  owner: string | null,
  registrations: readonly Registration[] = [],
  paused = false,
) {
  return { version, owner, paused, registrations };
}

function fakeIpc() {
  const invokes: Invoke[] = [];
  const pendingListens: {
    readonly event: string;
    readonly attach: () => void;
    readonly fail: (error: unknown) => void;
  }[] = [];
  const handlers = new Set<{ readonly event: string; readonly handler: (p: unknown) => void }>();

  const ipc: TauriIpc = {
    invoke<T>(command: string, args: Record<string, unknown> = {}) {
      return new Promise<T>((resolve, reject) => {
        invokes.push({
          command: command.replace('plugin:shortcutkit|', ''),
          args,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    },
    listen<T>(event: string, handler: (payload: T) => void) {
      return new Promise<() => void>((resolve, reject) => {
        pendingListens.push({
          event,
          attach: () => {
            const entry = { event, handler: handler as (p: unknown) => void };
            handlers.add(entry);
            resolve(() => handlers.delete(entry));
          },
          fail: reject,
        });
      });
    },
  };

  const syncs = () => invokes.filter((call) => call.command === 'sync_global_hotkeys');

  return {
    ipc,
    invokes,
    syncs,
    lastSync: () => {
      const last = syncs().at(-1);
      if (last === undefined) throw new Error('no sync sent');
      return last;
    },
    pendingListens: () => pendingListens.map((listen) => listen.event),
    resolveListens: async () => {
      pendingListens.splice(0).forEach((listen) => listen.attach());
      await tick();
    },
    rejectListen: async (event: string, error: unknown) => {
      pendingListens
        .splice(0)
        .forEach((listen) =>
          listen.event === `shortcutkit://${event}` ? listen.fail(error) : listen.attach(),
        );
      await tick();
    },
    emit: (event: string, payload: unknown) =>
      [...handlers]
        .filter((entry) => entry.event === `shortcutkit://${event}`)
        .forEach((entry) => entry.handler(payload)),
    listenerCount: () => handlers.size,
  };
}

type Fake = ReturnType<typeof fakeIpc>;

async function setup(options: Omit<AttachGlobalHotkeysOptions, 'ipc'> = {}) {
  const registry = await createRegistry({
    contexts: [app],
    platform: 'mac',
    store: memoryStore(),
    saveDebounceMs: 0,
  });
  const fake = fakeIpc();
  const hotkeys = attachGlobalHotkeys(registry, { ...options, ipc: fake.ipc });
  return { registry, fake, hotkeys };
}

async function started(options: Omit<AttachGlobalHotkeysOptions, 'ipc'> = {}) {
  const context = await setup(options);
  await context.fake.resolveListens();
  return { ...context, attachment: attachmentOf(context.fake) };
}

function attachmentOf(fake: Fake): string {
  return fake.lastSync().args['attachment'] as string;
}

function bindingsOf(call: Invoke): unknown {
  return call.args['bindings'];
}

function startRecorder(registry: ShortcutRegistry) {
  const recorder = createShortcutRecorder(registry, {
    onCommit: () => {},
    target: new EventTarget(),
  });
  recorder.start();
  return recorder;
}

describe('attachGlobalHotkeys', () => {
  it('waits for both listens before the first sync', async () => {
    const { fake } = await setup();
    await tick();
    expect(fake.pendingListens()).toEqual([
      'shortcutkit://global-pressed',
      'shortcutkit://global-state',
    ]);
    expect(fake.invokes).toEqual([]);
    await fake.resolveListens();
    expect(fake.syncs()).toHaveLength(1);
  });

  it('sends only supported bindings, as wire keys', async () => {
    const { fake } = await started();
    expect(fake.syncs()).toHaveLength(1);
    expect(bindingsOf(fake.lastSync())).toEqual([
      { id: SHOW, key: { code: 'KeyK', modifiers: MODS } },
      { id: HIDE, key: { code: 'KeyH', modifiers: MODS } },
    ]);
    expect(fake.lastSync().args['paused']).toBe(false);
  });

  it('carries the current recording state in the first sync', async () => {
    const { registry, fake } = await setup();
    const recorder = startRecorder(registry);
    await fake.resolveListens();
    expect(fake.lastSync().args['paused']).toBe(true);
    recorder.destroy();
  });

  it('sends one sync for several quick publishes and nothing for an unchanged one', async () => {
    const { registry, fake } = await started();
    fake.lastSync().resolve(globalState(1, null));
    await tick();
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+l', 'mac')]);
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+m', 'mac')]);
    await tick();
    expect(fake.syncs()).toHaveLength(2);
    expect(bindingsOf(fake.lastSync())).toEqual([
      { id: SHOW, key: { code: 'KeyM', modifiers: MODS } },
      { id: HIDE, key: { code: 'KeyH', modifiers: MODS } },
    ]);
    fake.lastSync().resolve(globalState(2, null));
    await tick();
    registry.setHintsEnabled(false);
    await tick();
    expect(fake.syncs()).toHaveLength(2);
  });

  it('sends syncs in order, one at a time, and ignores an older version', async () => {
    const { registry, fake, hotkeys, attachment } = await started();
    const first = fake.lastSync();
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    await tick();
    expect(fake.syncs()).toEqual([first]);
    fake.emit(
      'global-state',
      globalState(5, attachment, [{ id: SHOW, key: KEY_J, result: 'registered' }]),
    );
    first.resolve(globalState(4, null));
    await tick();
    expect(fake.syncs()).toHaveLength(2);
    expect(bindingsOf(fake.lastSync())).toEqual([
      { id: SHOW, key: { code: 'KeyJ', modifiers: MODS } },
      { id: HIDE, key: { code: 'KeyH', modifiers: MODS } },
    ]);
    expect(hotkeys.getSnapshot().isOwner).toBe(true);
    expect(hotkeys.getSnapshot().statuses.get(bindingKeyString(SHOW))).toEqual({
      type: 'registered',
    });
  });

  it('dispatches a press for this attachment and ignores one for another', async () => {
    const { registry, fake, attachment } = await started();
    const handler = vi.fn();
    registry.setGlobalHandler(app, handler);
    fake.emit('global-pressed', { attachment: 'someone-else', id: SHOW });
    expect(handler).not.toHaveBeenCalled();
    fake.emit('global-pressed', { attachment, id: HIDE });
    expect(handler.mock.calls).toEqual([['hide']]);
  });

  it('sends paused true when recording starts and false when it stops', async () => {
    const { registry, fake } = await started();
    fake.lastSync().resolve(globalState(1, null));
    await tick();
    const recorder = startRecorder(registry);
    await tick();
    expect(fake.lastSync().args['paused']).toBe(true);
    fake.lastSync().resolve(globalState(2, null, [], true));
    await tick();
    recorder.cancel();
    await tick();
    expect(fake.syncs().map((call) => call.args['paused'])).toEqual([false, true, false]);
    recorder.destroy();
  });

  it('reports paused and owner from the newest state', async () => {
    const { fake, hotkeys, attachment } = await started();
    expect(hotkeys.getSnapshot()).toMatchObject({ isOwner: false, paused: false });
    const listener = vi.fn();
    hotkeys.subscribe(listener);
    fake.emit('global-state', globalState(1, attachment, [], true));
    expect(hotkeys.getSnapshot()).toMatchObject({ isOwner: true, paused: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('derives every status kind', async () => {
    const meta = parseShortcut('ctrl+alt+meta+h', 'mac');
    const { fake, hotkeys, attachment } = await started({
      systemShortcuts: { get: () => [meta], refresh: () => Promise.resolve(false) },
    });
    const statuses = () => Object.fromEntries(hotkeys.getSnapshot().statuses);
    expect(statuses()).toEqual({
      [bindingKeyString(SHOW)]: { type: 'pending' },
      [bindingKeyString(HIDE)]: { type: 'pending' },
      [bindingKeyString(HIDE_SEQUENCE)]: { type: 'unsupported', reason: 'multiStepInGlobal' },
    });
    fake.lastSync().resolve(
      globalState(1, attachment, [
        { id: SHOW, key: KEY_K, result: 'failed', error: 'RegisterEventHotKey failed for KeyK' },
        { id: HIDE, key: KEY_H, result: 'registered' },
      ]),
    );
    await tick();
    expect(statuses()).toEqual({
      [bindingKeyString(SHOW)]: { type: 'failed', error: 'RegisterEventHotKey failed for KeyK' },
      [bindingKeyString(HIDE)]: { type: 'shadowedBySystem' },
      [bindingKeyString(HIDE_SEQUENCE)]: { type: 'unsupported', reason: 'multiStepInGlobal' },
    });
    fake.emit(
      'global-state',
      globalState(2, attachment, [{ id: SHOW, key: KEY_K, result: 'registered' }]),
    );
    expect(statuses()[bindingKeyString(SHOW)]).toEqual({ type: 'registered' });
  });

  it('shows a rebound binding as pending until its own result arrives', async () => {
    const { registry, fake, hotkeys, attachment } = await started();
    const show = () => hotkeys.getSnapshot().statuses.get(bindingKeyString(SHOW));
    fake
      .lastSync()
      .resolve(globalState(1, attachment, [{ id: SHOW, key: KEY_K, result: 'registered' }]));
    await tick();
    expect(show()).toEqual({ type: 'registered' });
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    expect(show()).toEqual({ type: 'pending' });
    await tick();
    fake
      .lastSync()
      .resolve(
        globalState(2, attachment, [{ id: SHOW, key: KEY_J, result: 'failed', error: 'taken' }]),
      );
    await tick();
    expect(show()).toEqual({ type: 'failed', error: 'taken' });
  });

  it('shows a binding that differs from the owner as pending', async () => {
    const { registry, fake, hotkeys } = await started();
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    fake.emit(
      'global-state',
      globalState(1, 'someone-else', [
        { id: SHOW, key: KEY_K, result: 'registered' },
        { id: HIDE, key: KEY_H, result: 'registered' },
      ]),
    );
    const { statuses } = hotkeys.getSnapshot();
    expect(statuses.get(bindingKeyString(SHOW))).toEqual({ type: 'pending' });
    expect(statuses.get(bindingKeyString(HIDE))).toEqual({ type: 'registered' });
  });

  it('marks a mouse binding unsupported and does not send it', async () => {
    const { registry, fake, hotkeys } = await started();
    fake.lastSync().resolve(globalState(1, null));
    await tick();
    registry.setShortcuts(app, 'show', [parseShortcut('meta+middle-click', 'mac')]);
    await tick();
    expect(hotkeys.getSnapshot().statuses.get(bindingKeyString(SHOW))).toEqual({
      type: 'unsupported',
      reason: 'mouseInGlobal',
    });
    expect(bindingsOf(fake.lastSync())).toEqual([
      { id: HIDE, key: { code: 'KeyH', modifiers: MODS } },
    ]);
  });

  it('detach sends detach_global_hotkeys, unlistens and stops dispatching', async () => {
    const { registry, fake, hotkeys, attachment } = await started();
    const handler = vi.fn();
    registry.setGlobalHandler(app, handler);
    const detached = hotkeys.detach();
    expect(fake.invokes.at(-1)).toMatchObject({
      command: 'detach_global_hotkeys',
      args: { attachment },
    });
    fake.invokes.at(-1)?.resolve(globalState(9, null));
    await detached;
    expect(fake.listenerCount()).toBe(0);
    fake.emit('global-pressed', { attachment, id: SHOW });
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    await tick();
    expect(handler).not.toHaveBeenCalled();
    expect(fake.syncs()).toHaveLength(1);
  });

  it('detaching before the listens resolve leaves no listener and sends nothing', async () => {
    const { fake, hotkeys } = await setup();
    await hotkeys.detach();
    await fake.resolveListens();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.invokes).toEqual([]);
  });

  it('sends no detach when the only sync failed', async () => {
    const { fake, hotkeys } = await started({ logger: { warn: vi.fn() } });
    fake.lastSync().reject('tauri-plugin-global-shortcut is not registered');
    await tick();
    await hotkeys.detach();
    expect(fake.invokes.map((call) => call.command)).toEqual(['sync_global_hotkeys']);
  });

  it('sends a detach after a failed sync when an earlier one succeeded', async () => {
    const { registry, fake, hotkeys, attachment } = await started({ logger: { warn: vi.fn() } });
    fake.lastSync().resolve(globalState(1, attachment));
    await tick();
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    await tick();
    fake.lastSync().reject('boom');
    await tick();
    const detached = hotkeys.detach();
    expect(fake.invokes.map((call) => call.command)).toEqual([
      'sync_global_hotkeys',
      'sync_global_hotkeys',
      'detach_global_hotkeys',
    ]);
    fake.invokes.at(-1)?.resolve(globalState(3, null));
    await detached;
  });

  it('detach is idempotent and sends one detach', async () => {
    const { fake, hotkeys } = await started();
    const first = hotkeys.detach();
    const second = hotkeys.detach();
    expect(second).toBe(first);
    fake.invokes.at(-1)?.resolve(globalState(1, null));
    await Promise.all([first, second]);
    await hotkeys.detach();
    expect(fake.invokes.map((call) => call.command)).toEqual([
      'sync_global_hotkeys',
      'detach_global_hotkeys',
    ]);
  });

  it('warns and resolves when the detach command fails', async () => {
    const warn = vi.fn();
    const { fake, hotkeys } = await started({ logger: { warn } });
    const detached = hotkeys.detach();
    fake.invokes.at(-1)?.reject(new Error('denied'));
    await expect(detached).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('detaching global hotkeys failed: Error: denied');
  });

  it('warns and never syncs when a listen fails', async () => {
    const warn = vi.fn();
    const { fake } = await setup({ logger: { warn } });
    await fake.rejectListen('global-state', new Error('not allowed'));
    expect(warn.mock.calls).toEqual([
      ['listening for shortcutkit://global-state failed: Error: not allowed'],
    ]);
    expect(fake.invokes).toEqual([]);
  });

  it('marks supported bindings failed with the command error until a sync succeeds', async () => {
    const { registry, fake, hotkeys, attachment } = await started({ logger: { warn: vi.fn() } });
    const listener = vi.fn();
    hotkeys.subscribe(listener);
    const statuses = () => Object.fromEntries(hotkeys.getSnapshot().statuses);
    fake.lastSync().reject('tauri-plugin-global-shortcut is not registered');
    await tick();
    const failed = { type: 'failed', error: 'tauri-plugin-global-shortcut is not registered' };
    expect(statuses()).toEqual({
      [bindingKeyString(SHOW)]: failed,
      [bindingKeyString(HIDE)]: failed,
      [bindingKeyString(HIDE_SEQUENCE)]: { type: 'unsupported', reason: 'multiStepInGlobal' },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+j', 'mac')]);
    await tick();
    expect(statuses()[bindingKeyString(SHOW)]).toEqual(failed);
    fake.lastSync().resolve(
      globalState(1, attachment, [
        { id: SHOW, key: KEY_J, result: 'registered' },
        { id: HIDE, key: KEY_H, result: 'registered' },
      ]),
    );
    await tick();
    expect(statuses()).toEqual({
      [bindingKeyString(SHOW)]: { type: 'registered' },
      [bindingKeyString(HIDE)]: { type: 'registered' },
      [bindingKeyString(HIDE_SEQUENCE)]: { type: 'unsupported', reason: 'multiStepInGlobal' },
    });
  });

  it('uses the message of an Error rejection as the failed error', async () => {
    const { fake, hotkeys } = await started({ logger: { warn: vi.fn() } });
    fake.lastSync().reject(new Error('missing permission'));
    await tick();
    expect(hotkeys.getSnapshot().statuses.get(bindingKeyString(SHOW))).toEqual({
      type: 'failed',
      error: 'missing permission',
    });
  });

  it('notifies subscribers on a change until they unsubscribe', async () => {
    const { fake, hotkeys, attachment } = await started();
    const kept = vi.fn();
    const dropped = vi.fn();
    hotkeys.subscribe(kept);
    const unsubscribe = hotkeys.subscribe(dropped);
    fake.emit('global-state', globalState(1, attachment));
    unsubscribe();
    fake.emit('global-state', globalState(2, attachment, [], true));
    expect(kept).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('keeps the snapshot and notifies nobody for a newer state with the same statuses', async () => {
    const { fake, hotkeys, attachment } = await started();
    const registrations = [{ id: SHOW, key: KEY_K, result: 'registered' as const }];
    fake.emit('global-state', globalState(1, attachment, registrations));
    const snapshot = hotkeys.getSnapshot();
    expect(hotkeys.getSnapshot()).toBe(snapshot);
    const listener = vi.fn();
    hotkeys.subscribe(listener);
    fake.emit('global-state', globalState(2, attachment, registrations));
    expect(listener).not.toHaveBeenCalled();
    expect(hotkeys.getSnapshot()).toBe(snapshot);
  });

  it('warns and retries a failed sync on the next change', async () => {
    const warn = vi.fn();
    const { registry, fake } = await started({ logger: { warn } });
    fake.lastSync().reject(new Error('tauri-plugin-global-shortcut is not registered'));
    await tick();
    expect(warn).toHaveBeenCalledWith(
      'syncing global hotkeys failed: Error: tauri-plugin-global-shortcut is not registered',
    );
    registry.setShortcuts(app, 'show', [parseShortcut('ctrl+alt+meta+k', 'mac')]);
    await tick();
    expect(fake.syncs()).toHaveLength(2);
  });
});
