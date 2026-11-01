import {
  consoleLogger,
  keyStep,
  sameShortcut,
  shortcutOf,
  type Shortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { command, defaultIpc, type IpcOptions } from './ipc';
import type { WireKey } from './wire';

export interface SystemShortcuts {
  readonly get: () => readonly Shortcut[];
  readonly refresh: () => Promise<boolean>;
}

export type SystemShortcutsOptions = IpcOptions;

const toShortcut = ({ code, modifiers }: WireKey): Shortcut =>
  shortcutOf(
    keyStep(code, {
      ctrl: modifiers.ctrl,
      alt: modifiers.alt,
      shift: modifiers.shift,
      meta: modifiers.meta,
    }),
  );

const sameList = (a: readonly Shortcut[], b: readonly Shortcut[]): boolean =>
  a.length === b.length &&
  a.every((shortcut, index) => {
    const other = b[index];
    return other !== undefined && sameShortcut(shortcut, other);
  });

export async function loadSystemShortcuts(
  options: SystemShortcutsOptions = {},
): Promise<SystemShortcuts> {
  const logger = options.logger ?? consoleLogger;
  const ipc = options.ipc ?? defaultIpc();
  const fetch = async (): Promise<readonly Shortcut[]> =>
    (await ipc.invoke<readonly WireKey[]>(command('system_shortcuts'))).map(toShortcut);

  let current: readonly Shortcut[] = [];
  try {
    current = await fetch();
  } catch (error) {
    logger.warn(`system shortcuts lookup failed: ${String(error)}`);
  }

  return {
    get: () => current,
    refresh: async () => {
      try {
        const next = await fetch();
        if (sameList(current, next)) return false;
        current = next;
        return true;
      } catch (error) {
        logger.warn(`system shortcuts refresh failed: ${String(error)}`);
        return false;
      }
    },
  };
}

export function watchSystemShortcuts(
  registry: Pick<ShortcutRegistry, 'refreshConflicts'>,
  shortcuts: SystemShortcuts,
  options: { readonly target?: EventTarget | undefined } = {},
): () => void {
  const target = options.target ?? window;
  let stopped = false;
  const onFocus = () => {
    void shortcuts.refresh().then((changed) => {
      if (changed && !stopped) registry.refreshConflicts();
    });
  };
  target.addEventListener('focus', onFocus);
  return () => {
    stopped = true;
    target.removeEventListener('focus', onFocus);
  };
}
