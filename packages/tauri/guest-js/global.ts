import {
  consoleLogger,
  sameShortcut,
  unsupportedInScope,
  type BindingId,
  type GlobalBinding,
  type Shortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { recordingStatus } from '@shortcutkit/dom';
import { command, defaultIpc, eventName, type IpcOptions } from './ipc';
import type { SystemShortcuts } from './system';
import type { WireKey } from './wire';

export type GlobalHotkeyStatus =
  | { readonly type: 'pending' }
  | { readonly type: 'registered' }
  | { readonly type: 'shadowedBySystem' }
  | { readonly type: 'failed'; readonly error: string }
  | { readonly type: 'unsupported'; readonly reason: 'multiStepInGlobal' | 'mouseInGlobal' };

export interface GlobalHotkeysSnapshot {
  readonly isOwner: boolean;
  readonly paused: boolean;
  readonly statuses: ReadonlyMap<string, GlobalHotkeyStatus>;
}

export interface GlobalHotkeys {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => GlobalHotkeysSnapshot;
  readonly detach: () => Promise<void>;
}

export interface AttachGlobalHotkeysOptions extends IpcOptions {
  readonly systemShortcuts?: SystemShortcuts | undefined;
}

interface BindingKey {
  readonly contextId: string;
  readonly actionId: string;
  readonly bindingIndex: number;
}

interface WireGlobalBinding {
  readonly id: BindingKey;
  readonly key: WireKey;
}

interface Registration {
  readonly id: BindingKey;
  readonly key: WireKey;
  readonly result: 'registered' | 'failed';
  readonly error?: string | undefined;
}

interface GlobalState {
  readonly version: number;
  readonly owner: string | null;
  readonly paused: boolean;
  readonly registrations: readonly Registration[];
}

interface PressedEvent {
  readonly attachment: string;
  readonly id: BindingKey;
}

export function bindingKeyString(id: BindingId): string {
  return JSON.stringify([id.contextId, id.actionId, id.bindingIndex]);
}

function wireBinding({ id, shortcut }: GlobalBinding): WireGlobalBinding[] {
  const [step] = shortcut.steps;
  if (unsupportedInScope(shortcut, 'global') !== undefined || step?.input.type !== 'key') return [];
  const { ctrl, alt, shift, meta } = step.modifiers;
  return [
    {
      id: { contextId: id.contextId, actionId: id.actionId, bindingIndex: id.bindingIndex },
      key: { code: step.input.code, modifiers: { ctrl, alt, shift, meta } },
    },
  ];
}

function sameWireKey(a: WireKey, b: WireKey): boolean {
  return (
    a.code === b.code &&
    a.modifiers.ctrl === b.modifiers.ctrl &&
    a.modifiers.alt === b.modifiers.alt &&
    a.modifiers.shift === b.modifiers.shift &&
    a.modifiers.meta === b.modifiers.meta
  );
}

const PENDING: GlobalHotkeyStatus = { type: 'pending' };
const REGISTERED: GlobalHotkeyStatus = { type: 'registered' };
const SHADOWED: GlobalHotkeyStatus = { type: 'shadowedBySystem' };

function statusOf(
  binding: GlobalBinding,
  state: GlobalState | undefined,
  system: readonly Shortcut[],
  commandError: string | undefined,
): GlobalHotkeyStatus {
  const reason = unsupportedInScope(binding.shortcut, 'global');
  if (reason !== undefined) return { type: 'unsupported', reason };
  if (commandError !== undefined) return { type: 'failed', error: commandError };
  const id = bindingKeyString(binding.id);
  const wire = wireBinding(binding)[0]?.key;
  const registration = state?.registrations.find(
    (r) => bindingKeyString(r.id) === id && wire !== undefined && sameWireKey(r.key, wire),
  );
  if (registration === undefined) return PENDING;
  if (registration.result === 'failed') {
    return { type: 'failed', error: registration.error ?? 'registration failed' };
  }
  return system.some((shortcut) => sameShortcut(shortcut, binding.shortcut))
    ? SHADOWED
    : REGISTERED;
}

function sameStatus(a: GlobalHotkeyStatus, b: GlobalHotkeyStatus | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function sameSnapshot(a: GlobalHotkeysSnapshot, b: GlobalHotkeysSnapshot): boolean {
  return (
    a.isOwner === b.isOwner &&
    a.paused === b.paused &&
    a.statuses.size === b.statuses.size &&
    [...a.statuses].every(([key, status]) => sameStatus(status, b.statuses.get(key)))
  );
}

export function attachGlobalHotkeys(
  registry: ShortcutRegistry,
  options: AttachGlobalHotkeysOptions = {},
): GlobalHotkeys {
  const ipc = options.ipc ?? defaultIpc();
  const logger = options.logger ?? consoleLogger;
  const attachment = crypto.randomUUID();
  const recording = recordingStatus(registry);
  const listeners = new Set<() => void>();
  const unlistens: (() => void)[] = [];
  let latest: GlobalState | undefined;
  let commandError: string | undefined;
  let held = false;
  let synced = false;
  let stopped = false;
  let started = false;
  let lastSent: string | undefined;
  let chain = Promise.resolve();
  let detaching: Promise<void> | undefined;

  const compute = (): GlobalHotkeysSnapshot => {
    const system = options.systemShortcuts?.get() ?? [];
    return {
      isOwner: latest?.owner === attachment,
      paused: latest?.paused ?? false,
      statuses: new Map(
        registry
          .globalBindings()
          .map((binding) => [
            bindingKeyString(binding.id),
            statusOf(binding, latest, system, commandError),
          ]),
      ),
    };
  };
  let snapshot = compute();

  const refresh = () => {
    const next = compute();
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    [...listeners].forEach((listener) => listener());
  };

  const applyState = (state: GlobalState) => {
    if (latest !== undefined && state.version <= latest.version) return;
    latest = state;
    refresh();
  };

  const sendSync = async () => {
    if (stopped) return;
    const args = {
      attachment,
      bindings: registry.globalBindings().flatMap(wireBinding),
      paused: recording.getSnapshot(),
    };
    const content = JSON.stringify(args);
    if (content === lastSent) return;
    lastSent = content;
    held = true;
    let state: GlobalState;
    try {
      state = await ipc.invoke<GlobalState>(command('sync_global_hotkeys'), args);
    } catch (error) {
      lastSent = undefined;
      held = synced;
      commandError = error instanceof Error ? error.message : String(error);
      logger.warn(`syncing global hotkeys failed: ${String(error)}`);
      refresh();
      return;
    }
    synced = true;
    commandError = undefined;
    applyState(state);
    refresh();
  };

  const queueSync = () => {
    if (stopped || !started) return;
    chain = chain.then(sendSync);
  };

  const listen = <T>(name: string, handler: (payload: T) => void): Promise<boolean> => {
    let listening: Promise<() => void>;
    try {
      listening = ipc.listen<T>(eventName(name), handler);
    } catch (error) {
      listening = Promise.reject(error);
    }
    return listening.then(
      (unlisten) => {
        if (stopped) unlisten();
        else unlistens.push(unlisten);
        return true;
      },
      (error: unknown) => {
        logger.warn(`listening for ${eventName(name)} failed: ${String(error)}`);
        return false;
      },
    );
  };

  const onPressed = (event: PressedEvent) => {
    if (stopped || event.attachment !== attachment) return;
    registry.dispatchGlobal({ contextId: event.id.contextId, actionId: event.id.actionId });
  };

  const onState = (state: GlobalState) => {
    if (!stopped) applyState(state);
  };

  const unsubscribeRegistry = registry.subscribe(() => {
    refresh();
    queueSync();
  });
  const unsubscribeRecording = recording.subscribe(queueSync);

  void Promise.all([
    listen<PressedEvent>('global-pressed', onPressed),
    listen<GlobalState>('global-state', onState),
  ]).then((listening) => {
    if (stopped || !listening.every(Boolean)) return;
    started = true;
    queueSync();
  });

  const detach = (): Promise<void> => {
    if (detaching !== undefined) return detaching;
    stopped = true;
    unsubscribeRegistry();
    unsubscribeRecording();
    unlistens.splice(0).forEach((unlisten) => unlisten());
    if (!held) {
      detaching = Promise.resolve();
      return detaching;
    }
    detaching = (async () => {
      try {
        applyState(await ipc.invoke<GlobalState>(command('detach_global_hotkeys'), { attachment }));
      } catch (error) {
        logger.warn(`detaching global hotkeys failed: ${String(error)}`);
      }
    })();
    return detaching;
  };

  return {
    subscribe(listener) {
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    getSnapshot: () => snapshot,
    detach,
  };
}
