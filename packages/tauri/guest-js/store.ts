import { consoleLogger, encodeRawState, type SyncedShortcutStore } from '@shortcutkit/core';
import { command, defaultIpc, eventName, type IpcOptions } from './ipc';
import { initialSyncState, stepSync, type SyncInput } from './store-sync';

export interface TauriStoreOptions extends IpcOptions {
  readonly file?: string | undefined;
}

interface StateSnapshot {
  readonly revision: number;
  readonly state: unknown;
}

interface StateEvent {
  readonly file: string;
  readonly revision: number;
}

function rethrowAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

export function tauriStore(options: TauriStoreOptions = {}): SyncedShortcutStore {
  const file = options.file ?? 'shortcuts.json';
  const ipc = () => options.ipc ?? defaultIpc();
  const logger = options.logger ?? consoleLogger;
  const listeners = new Set<{ readonly notify: (state: unknown) => void }>();
  let sync = initialSyncState;

  const loadState = () => ipc().invoke<StateSnapshot>(command('load_state'), { file });

  const apply = (input: SyncInput): void => {
    const step = stepSync(sync, input);
    sync = step.state;
    if (step.read) void reread();
    if (step.report === undefined) return;
    const state = step.report.state ?? undefined;
    [...listeners].forEach(({ notify }) => {
      try {
        notify(state);
      } catch (error) {
        rethrowAsync(error);
      }
    });
  };

  const reread = async () => {
    let snapshot: StateSnapshot;
    try {
      snapshot = await loadState();
    } catch (error) {
      logger.warn(`re-reading "${file}" failed: ${String(error)}`);
      apply({ type: 'readFailed' });
      return;
    }
    apply({ type: 'readResolved', revision: snapshot.revision, state: snapshot.state });
  };

  const probe = async () => {
    try {
      apply({ type: 'announced', revision: (await loadState()).revision });
    } catch (error) {
      logger.warn(`reading "${file}" after subscribing failed: ${String(error)}`);
    }
  };

  return {
    async load() {
      let snapshot = await loadState();
      if (sync.seen > snapshot.revision) snapshot = await loadState();
      apply({ type: 'loaded', revision: snapshot.revision });
      return snapshot.state ?? undefined;
    },
    async save(state) {
      apply({ type: 'saveStarted' });
      let revision: number | undefined;
      try {
        ({ revision } = await ipc().invoke<{ revision: number }>(command('save_state'), {
          file,
          state: encodeRawState(state),
        }));
      } finally {
        apply({ type: 'saveSettled', revision });
      }
    },
    onExternalChange(listener) {
      const entry = { notify: listener };
      let stopped = false;
      let unlisten: (() => void) | undefined;
      listeners.add(entry);
      apply({ type: 'subscribed' });
      let listening: Promise<() => void>;
      try {
        listening = ipc().listen<StateEvent>(eventName('state'), (event) => {
          if (!stopped && event.file === file) {
            apply({ type: 'announced', revision: event.revision });
          }
        });
      } catch (error) {
        listening = Promise.reject(error);
      }
      listening.then(
        (resolved) => {
          if (stopped) {
            resolved();
            return;
          }
          unlisten = resolved;
          void probe();
        },
        (error: unknown) => logger.warn(`listening for "${file}" changes failed: ${String(error)}`),
      );
      return () => {
        if (stopped) return;
        stopped = true;
        listeners.delete(entry);
        apply({ type: 'unsubscribed' });
        unlisten?.();
      };
    },
  };
}
