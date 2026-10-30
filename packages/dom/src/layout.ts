import { consoleLogger, usLayout, type KeyboardLayout, type Logger } from '@shortcutkit/core';
import { createSubscribers } from './subscribers';

export interface KeyboardLayoutProvider {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => KeyboardLayout;
  readonly refresh: () => Promise<void>;
}

export interface KeyboardLayoutOptions {
  readonly load?: (() => Promise<ReadonlyMap<string, string> | undefined>) | undefined;
  readonly target?: EventTarget | undefined;
  readonly logger?: Pick<Logger, 'warn'> | undefined;
}

interface LayoutKeyboard {
  getLayoutMap?(): Promise<Iterable<readonly [string, string]>>;
}

export async function systemLayoutMap(): Promise<ReadonlyMap<string, string> | undefined> {
  const keyboard = (navigator as Navigator & { keyboard?: LayoutKeyboard }).keyboard;
  if (!keyboard?.getLayoutMap) return undefined;
  return new Map(await keyboard.getLayoutMap());
}

function sameMap(
  a: ReadonlyMap<string, string> | undefined,
  b: ReadonlyMap<string, string> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.size === b.size && [...a].every(([code, value]) => b.get(code) === value);
}

export function keyboardLayoutProvider(
  options: KeyboardLayoutOptions = {},
): KeyboardLayoutProvider {
  const load = options.load ?? systemLayoutMap;
  const logger = options.logger ?? consoleLogger;
  let current: ReadonlyMap<string, string> | undefined;
  let snapshot: KeyboardLayout = usLayout;
  let latest = 0;
  let warned = false;

  const refresh = async (): Promise<void> => {
    const id = ++latest;
    let map: ReadonlyMap<string, string> | undefined;
    try {
      map = await load();
    } catch (error) {
      if (id === latest && !warned) {
        logger.warn(`keyboard layout lookup failed: ${String(error)}`);
        warned = true;
      }
      return;
    }
    if (id !== latest) return;
    if (sameMap(map, current)) return;
    current = map;
    snapshot = map === undefined ? usLayout : (code) => map.get(code);
    subscribers.notify();
  };

  const getSnapshot = (): KeyboardLayout => snapshot;

  let stopFocus: (() => void) | undefined;

  const subscribers = createSubscribers({
    onFirst: () => {
      const target = options.target ?? window;
      const onFocus = () => {
        void refresh();
      };
      target.addEventListener('focus', onFocus);
      stopFocus = () => target.removeEventListener('focus', onFocus);
      void refresh();
    },
    onLast: () => {
      stopFocus?.();
      stopFocus = undefined;
    },
  });

  return { subscribe: subscribers.subscribe, getSnapshot, refresh };
}
