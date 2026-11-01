import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { Logger } from '@shortcutkit/core';

export interface TauriIpc {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  // Listens on the current webview only.
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

export interface IpcOptions {
  readonly ipc?: TauriIpc | undefined;
  readonly logger?: Pick<Logger, 'warn'> | undefined;
}

export function defaultIpc(): TauriIpc {
  return {
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
    listen: <T>(event: string, handler: (payload: T) => void) =>
      getCurrentWebview().listen<T>(event, (message) => handler(message.payload)),
  };
}

export const command = (name: string): string => `plugin:shortcutkit|${name}`;
export const eventName = (name: string): string => `shortcutkit://${name}`;
