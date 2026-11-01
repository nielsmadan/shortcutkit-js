import { systemLayoutMap } from '@shortcutkit/dom';
import { command, defaultIpc, type TauriIpc } from './ipc';

export interface TauriLayoutOptions {
  readonly ipc?: TauriIpc | undefined;
}

export async function tauriLayoutMap(
  options: TauriLayoutOptions = {},
): Promise<ReadonlyMap<string, string> | undefined> {
  let domError: { readonly error: unknown } | undefined;
  try {
    const fromDom = await systemLayoutMap();
    if (fromDom !== undefined) return fromDom;
  } catch (error) {
    domError = { error };
  }
  const ipc = options.ipc ?? defaultIpc();
  const map = await ipc.invoke<Readonly<Record<string, string>> | null>(command('keyboard_layout'));
  if (map !== null) return new Map(Object.entries(map));
  if (domError !== undefined) throw domError.error;
  return undefined;
}
