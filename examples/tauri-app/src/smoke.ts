import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { BackgroundThrottlingPolicy } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  decodeRawState,
  formatShortcut,
  parseShortcut,
  sameShortcut,
  type SaveResult,
  type Shortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { createShortcutRecorder } from '@shortcutkit/dom';
import {
  attachGlobalHotkeys,
  bindingKeyString,
  tauriLayoutMap,
  tauriStore,
  syncMenuAccelerators,
  toAccelerator,
  type GlobalHotkeys,
  type MenuBinding,
  type SystemShortcuts,
} from '@shortcutkit/tauri';
import { app, editor } from './contexts';

export interface SmokeEnv {
  readonly registry: ShortcutRegistry;
  readonly hotkeys: GlobalHotkeys;
  readonly systemShortcuts: SystemShortcuts;
  readonly menuBindings: readonly MenuBinding[];
  readonly menuError?: unknown;
}

export interface SmokeCheck {
  readonly name: string;
  readonly run: (env: SmokeEnv) => Promise<string>;
}

export interface SmokeResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const ROUNDTRIP_SAVE = 'mod+shift+s';
const ROUNDTRIP_SAVE_ALT = 'mod+shift+d';
const PEER_FIND = 'mod+shift+f';
const BROADCAST_TIMEOUT_MS = 5000;
const GLOBAL_SHOW = 'ctrl+alt+shift+f18';
const GLOBAL_TIMEOUT_MS = 5000;
const MENU_SYNC_TIMEOUT_MS = 5000;
const MENU_UPDATE_SAVE = 'mod+shift+k';
const HANDOVER_TIMEOUT_MS = 5000;
const PEER_ATTACHED_EVENT = 'smoke://peer-attached';
// @tauri-apps/api exports this enum as a type only.
const NO_THROTTLING = 'disabled' as BackgroundThrottlingPolicy;
const SHOW_ID = bindingKeyString({ contextId: app.id, actionId: 'showWindow', bindingIndex: 0 });

const report = (line: string): Promise<void> => invoke('smoke_report', { line });

function describeSave(saved: SaveResult | undefined): string {
  if (saved === undefined) return 'nothing pending';
  if (saved.type === 'saved') return 'saved';
  return `failed: ${String(saved.error)}`;
}

interface Subscribable {
  readonly subscribe: (listener: () => void) => () => void;
}

function waitFor(
  registry: Subscribable,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (predicate()) {
      resolve(true);
      return;
    }
    const finish = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = registry.subscribe(() => {
      if (predicate()) finish(true);
    });
  });
}

function openPeer(): Promise<WebviewWindow> {
  return new Promise((resolve, reject) => {
    const peer = new WebviewWindow('smoke-peer', {
      url: 'index.html?role=smoke-peer',
      title: 'ShortcutKit smoke peer',
      visible: false,
      backgroundThrottling: NO_THROTTLING,
    });
    void peer.once('tauri://created', () => resolve(peer));
    void peer.once('tauri://error', (event) =>
      reject(new Error(`opening the peer failed: ${JSON.stringify(event.payload)}`)),
    );
  });
}

async function storeRoundtrip({ registry }: SmokeEnv): Promise<string> {
  await registry.flush();
  const [current] = registry.shortcuts(editor, 'save');
  const first = parseShortcut(ROUNDTRIP_SAVE, registry.platform);
  const shortcut =
    current !== undefined && sameShortcut(current, first)
      ? parseShortcut(ROUNDTRIP_SAVE_ALT, registry.platform)
      : first;
  registry.setShortcuts(editor, 'save', [shortcut]);
  const saved = await registry.flush();
  if (saved?.type !== 'saved') throw new Error(`flush: ${describeSave(saved)}`);
  const loaded = decodeRawState(await tauriStore().load());
  const stored = loaded.overrides['editor']?.['save'];
  const expected = formatShortcut(shortcut);
  if (stored?.length !== 1 || stored[0] !== expected) {
    throw new Error(
      `fresh load has editor.save ${JSON.stringify(stored)}, expected ["${expected}"]`,
    );
  }
  return `fresh load has editor.save ["${expected}"]`;
}

async function storeBroadcast({ registry }: SmokeEnv): Promise<string> {
  const expected = parseShortcut(PEER_FIND, registry.platform);
  if (registry.shortcuts(editor, 'find').some((shortcut) => sameShortcut(shortcut, expected))) {
    throw new Error(`editor.find is already ${PEER_FIND} before the peer opened`);
  }
  const peer = await openPeer();
  try {
    const started = performance.now();
    const arrived = await waitFor(
      registry,
      () => registry.shortcuts(editor, 'find').some((shortcut) => sameShortcut(shortcut, expected)),
      BROADCAST_TIMEOUT_MS,
    );
    const elapsed = Math.round(performance.now() - started);
    if (!arrived) {
      throw new Error(`editor.find did not become ${PEER_FIND} within ${BROADCAST_TIMEOUT_MS} ms`);
    }
    return `peer's editor.find ${formatShortcut(expected)} arrived after ${elapsed} ms`;
  } finally {
    await peer.close();
  }
}

function osAccelerator(shortcut: Shortcut): string {
  const [step] = shortcut.steps;
  if (step?.input.type !== 'key') throw new Error(`${formatShortcut(shortcut)} is not a key`);
  const { ctrl, alt, shift, meta } = step.modifiers;
  const mods = [ctrl && 'control', alt && 'alt', shift && 'shift', meta && 'super'];
  return [...mods.filter(Boolean), step.input.code].join('+');
}

const osHolds = (shortcut: Shortcut): Promise<boolean> =>
  invoke('smoke_global_registered', { shortcut: osAccelerator(shortcut) });

function describeGlobal(hotkeys: GlobalHotkeys): string {
  const { isOwner, paused, statuses } = hotkeys.getSnapshot();
  return `owner ${String(isOwner)}, paused ${String(paused)}, status ${JSON.stringify(statuses.get(SHOW_ID))}`;
}

async function globalRegister({ registry, hotkeys }: SmokeEnv): Promise<string> {
  const shortcut = parseShortcut(GLOBAL_SHOW, registry.platform);
  registry.setShortcuts(app, 'showWindow', [shortcut]);
  const registered = await waitFor(
    hotkeys,
    () => {
      const { isOwner, statuses } = hotkeys.getSnapshot();
      const status = statuses.get(SHOW_ID)?.type;
      return (
        isOwner && (status === 'registered' || status === 'shadowedBySystem' || status === 'failed')
      );
    },
    GLOBAL_TIMEOUT_MS,
  );
  if (!registered) {
    throw new Error(
      `${GLOBAL_SHOW} has no result within ${GLOBAL_TIMEOUT_MS} ms: ${describeGlobal(hotkeys)}`,
    );
  }
  const status = hotkeys.getSnapshot().statuses.get(SHOW_ID);
  if (status?.type === 'failed') {
    throw new Error(`${GLOBAL_SHOW} was refused: ${status.error}`);
  }
  if (!(await osHolds(shortcut))) {
    throw new Error(`status is registered but the OS does not hold ${osAccelerator(shortcut)}`);
  }
  return `${osAccelerator(shortcut)} registered: ${describeGlobal(hotkeys)}`;
}

async function globalPause({ registry, hotkeys }: SmokeEnv): Promise<string> {
  const shortcut = parseShortcut(GLOBAL_SHOW, registry.platform);
  if (!(await osHolds(shortcut)))
    throw new Error(`${GLOBAL_SHOW} is not registered before recording`);
  const recorder = createShortcutRecorder(registry, {
    onCommit: () => {},
    target: new EventTarget(),
  });
  try {
    recorder.start();
    const paused = await waitFor(hotkeys, () => hotkeys.getSnapshot().paused, GLOBAL_TIMEOUT_MS);
    if (!paused) throw new Error(`not paused while recording: ${describeGlobal(hotkeys)}`);
    if (await osHolds(shortcut)) throw new Error(`the OS still holds ${GLOBAL_SHOW} while paused`);
    recorder.cancel();
    const resumed = await waitFor(hotkeys, () => !hotkeys.getSnapshot().paused, GLOBAL_TIMEOUT_MS);
    if (!resumed) throw new Error(`still paused after cancelling: ${describeGlobal(hotkeys)}`);
    if (!(await osHolds(shortcut))) {
      throw new Error(`${GLOBAL_SHOW} not registered again after cancelling`);
    }
    return `unregistered while recording, registered again after cancel: ${describeGlobal(hotkeys)}`;
  } finally {
    recorder.destroy();
  }
}

async function menuAccelerators({ registry, menuBindings }: SmokeEnv): Promise<string> {
  const sent: { action: string; accelerator: string }[] = [];
  const spies: MenuBinding[] = menuBindings.map((binding) => ({
    ...binding,
    item: {
      setAccelerator: async (accelerator) => {
        if (accelerator !== null) {
          await invoke('smoke_parse_accelerator', { accelerator });
          sent.push({ action: binding.action, accelerator });
        }
        await binding.item.setAccelerator(accelerator);
      },
    },
  }));
  const expected = menuBindings.flatMap((binding) => {
    const [first] = registry.shortcuts(binding.context, binding.action);
    const accelerator = first && toAccelerator(first, registry.platform);
    return accelerator === undefined ? [] : [`${binding.action} ${accelerator}`];
  });
  if (expected.length === 0) throw new Error('no editor binding produced an accelerator');
  const actual = () => sent.map(({ action, accelerator }) => `${action} ${accelerator}`);
  const missing = () => expected.filter((entry) => !actual().includes(entry));
  const stop = syncMenuAccelerators(registry, spies);
  try {
    const deadline = performance.now() + MENU_SYNC_TIMEOUT_MS;
    while (missing().length > 0 && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    stop();
  }
  if (missing().length > 0) {
    throw new Error(`sync did not send ${missing().join(', ')}; it sent ${actual().join(', ')}`);
  }
  return expected.join(', ');
}

function spyOn(bindings: readonly MenuBinding[], sent: string[]): MenuBinding[] {
  return bindings.map((binding) => ({
    ...binding,
    item: {
      setAccelerator: async (accelerator) => {
        if (accelerator !== null) await invoke('smoke_parse_accelerator', { accelerator });
        await binding.item.setAccelerator(accelerator);
        sent.push(`${binding.action} ${String(accelerator)}`);
      },
    },
  }));
}

async function sentWithin(sent: readonly string[], entry: string): Promise<boolean> {
  const deadline = performance.now() + MENU_SYNC_TIMEOUT_MS;
  while (!sent.includes(entry) && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return sent.includes(entry);
}

async function menuUpdate({ registry, menuBindings }: SmokeEnv): Promise<string> {
  const save = menuBindings.find((binding) => binding.action === 'save');
  if (save === undefined) throw new Error('the menu has no Save item');
  const sent: string[] = [];
  const stop = syncMenuAccelerators(registry, spyOn([save], sent));
  const steps: readonly (readonly [string, string])[] = [
    [
      MENU_UPDATE_SAVE,
      `save ${String(toAccelerator(parseShortcut(MENU_UPDATE_SAVE, registry.platform), registry.platform))}`,
    ],
    ['g g', 'save null'],
  ];
  try {
    for (const [shortcut, entry] of steps) {
      registry.setShortcuts(editor, 'save', [parseShortcut(shortcut, registry.platform)]);
      if (!(await sentWithin(sent, entry))) {
        throw new Error(
          `after ${shortcut} the sync did not send "${entry}"; it sent ${sent.join(', ')}`,
        );
      }
    }
    registry.reset(editor, 'save');
    const [reset] = registry.shortcuts(editor, 'save');
    const entry = `save ${String(reset && toAccelerator(reset, registry.platform))}`;
    if (!(await sentWithin(sent, entry))) {
      throw new Error(`after reset the sync did not send "${entry}"; it sent ${sent.join(', ')}`);
    }
  } finally {
    stop();
  }
  return sent.join(', ');
}

interface PluginGlobalState {
  readonly owner: string | null;
}

const pluginOwner = async (): Promise<string | null> =>
  (await invoke<PluginGlobalState>('plugin:shortcutkit|global_hotkeys_state')).owner;

async function openAttachedPeer(): Promise<WebviewWindow> {
  let unlisten: (() => void) | undefined;
  const attached = new Promise<void>((resolve) => {
    void listen(PEER_ATTACHED_EVENT, () => resolve()).then((stop) => {
      unlisten = stop;
    });
  });
  try {
    const peer = await openPeer();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('the peer did not attach within 5 s')),
        HANDOVER_TIMEOUT_MS,
      ),
    );
    await Promise.race([attached, timeout]);
    return peer;
  } finally {
    unlisten?.();
  }
}

async function globalHandover({ registry, hotkeys, systemShortcuts }: SmokeEnv): Promise<string> {
  const shortcut = parseShortcut(GLOBAL_SHOW, registry.platform);
  const peer = await openAttachedPeer();
  let closed = false;
  try {
    if (!hotkeys.getSnapshot().isOwner) throw new Error('main is not the owner with the peer open');
    await hotkeys.detach();
    const peerOwner = await pluginOwner();
    if (peerOwner === null) throw new Error('nobody owns the hotkeys after main detached');
    if (!(await osHolds(shortcut)))
      throw new Error(`${GLOBAL_SHOW} is not registered for the peer`);
    const rejoined = attachGlobalHotkeys(registry, { systemShortcuts });
    const settled = await waitFor(
      rejoined,
      () => rejoined.getSnapshot().statuses.get(SHOW_ID)?.type === 'registered',
      HANDOVER_TIMEOUT_MS,
    );
    if (!settled || rejoined.getSnapshot().isOwner) {
      throw new Error(`main re-attached as ${describeGlobal(rejoined)}, expected behind the peer`);
    }
    await peer.close();
    closed = true;
    const owns = await waitFor(rejoined, () => rejoined.getSnapshot().isOwner, HANDOVER_TIMEOUT_MS);
    if (!owns)
      throw new Error(`main did not take over when the peer closed: ${describeGlobal(rejoined)}`);
    if (!(await osHolds(shortcut)))
      throw new Error(`${GLOBAL_SHOW} is not registered after the handover`);
    return `main detached: the peer owned ${osAccelerator(shortcut)}; the peer closed: main owns it again`;
  } finally {
    if (!closed) await peer.close();
  }
}

async function layoutLookup(): Promise<string> {
  const map = await tauriLayoutMap();
  if (map === undefined) throw new Error('no layout map');
  if (map.size === 0) throw new Error('the layout map is empty');
  const keyA = map.get('KeyA');
  if (keyA === undefined) throw new Error(`the layout map has no KeyA among ${map.size} keys`);
  return `${map.size} keys, KeyA is "${keyA}"`;
}

function systemShortcutsList({ systemShortcuts }: SmokeEnv): Promise<string> {
  const list = systemShortcuts.get();
  if (list.length === 0) throw new Error('the system shortcut list is empty');
  const first = list.slice(0, 3).map(formatShortcut).join(', ');
  return Promise.resolve(`${list.length} entries, first three: ${first}`);
}

export const checks: readonly SmokeCheck[] = [
  { name: 'store-roundtrip', run: storeRoundtrip },
  { name: 'store-broadcast', run: storeBroadcast },
  { name: 'global-register', run: globalRegister },
  { name: 'global-pause', run: globalPause },
  { name: 'menu-accelerators', run: menuAccelerators },
  { name: 'menu-update', run: menuUpdate },
  { name: 'layout', run: layoutLookup },
  { name: 'system-shortcuts', run: systemShortcutsList },
  { name: 'global-handover', run: globalHandover },
];

async function runCheck(check: SmokeCheck, env: SmokeEnv): Promise<SmokeResult> {
  try {
    return { name: check.name, passed: true, detail: await check.run(env) };
  } catch (error) {
    return { name: check.name, passed: false, detail: String(error) };
  }
}

async function runChecks(env: SmokeEnv): Promise<void> {
  const { registry } = env;
  if (env.menuError !== undefined) {
    throw new Error(`building the app menu failed: ${String(env.menuError)}`);
  }
  const results: SmokeResult[] = [];
  for (const check of checks) {
    const result = await runCheck(check, env);
    results.push(result);
    await report(`${result.passed ? 'pass' : 'FAIL'} ${result.name}: ${result.detail}`);
  }
  const passed = results.every((result) => result.passed);
  const json = JSON.stringify(
    { platform: registry.platform, userAgent: navigator.userAgent, passed, checks: results },
    null,
    2,
  );
  await invoke('smoke_finish', { json: `${json}\n`, passed });
}

export async function runSmoke(env: SmokeEnv): Promise<void> {
  try {
    await runChecks(env);
  } catch (error) {
    const json = JSON.stringify({
      platform: env.registry.platform,
      passed: false,
      error: String(error),
    });
    await invoke('smoke_finish', { json: `${json}\n`, passed: false });
  }
}

export async function runSmokePeer(
  registry: ShortcutRegistry,
  hotkeys: GlobalHotkeys,
): Promise<void> {
  registry.setShortcuts(editor, 'find', [parseShortcut(PEER_FIND, registry.platform)]);
  const saved = await registry.flush();
  await report(`peer: ${describeSave(saved)}`);
  await waitFor(
    hotkeys,
    () => hotkeys.getSnapshot().statuses.get(SHOW_ID)?.type !== 'pending',
    GLOBAL_TIMEOUT_MS,
  );
  await emitTo('main', PEER_ATTACHED_EVENT);
}
