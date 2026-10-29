import {
  consoleLogger,
  encodeRawState,
  type Logger,
  type SyncedShortcutStore,
} from '@shortcutkit/core';

export interface LocalStorageStoreOptions {
  readonly key?: string | undefined;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly target?: EventTarget | undefined;
  readonly logger?: Pick<Logger, 'warn'> | undefined;
}

export function localStorageStore(options: LocalStorageStoreOptions = {}): SyncedShortcutStore {
  const key = options.key ?? 'shortcutkit.state';
  const storage = () => options.storage ?? localStorage;
  const logger = options.logger ?? consoleLogger;

  const read = (): unknown => {
    const text = storage().getItem(key);
    return text === null ? undefined : JSON.parse(text);
  };

  return {
    load: async () => read(),
    save: async (state) => storage().setItem(key, JSON.stringify(encodeRawState(state))),
    onExternalChange(listener) {
      const target = options.target ?? window;
      const notify = () => {
        let state: unknown;
        try {
          state = read();
        } catch (error) {
          const problem = error instanceof SyntaxError ? 'unparseable state' : 'unreadable storage';
          logger.warn(`ignoring ${problem} in localStorage "${key}": ${String(error)}`);
          return;
        }
        listener(state);
      };
      const onStorage = (event: Event) => {
        const eventKey = (event as StorageEvent).key;
        if (eventKey !== null && eventKey !== key) return;
        notify();
      };
      const onPageShow = (event: Event) => {
        if ((event as PageTransitionEvent).persisted) notify();
      };
      target.addEventListener('storage', onStorage);
      target.addEventListener('pageshow', onPageShow);
      return () => {
        target.removeEventListener('storage', onStorage);
        target.removeEventListener('pageshow', onPageShow);
      };
    },
  };
}
