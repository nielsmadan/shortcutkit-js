export type LogKind = 'fired' | 'debug' | 'sync' | 'save' | 'reload';

export interface LogEntry {
  readonly id: number;
  readonly kind: LogKind;
  readonly text: string;
}

export interface LogSnapshot {
  readonly entries: readonly LogEntry[];
  readonly stored: string;
}

export interface LogStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LogSnapshot;
  write(kind: LogKind, text: string): void;
  clear(): void;
  refreshStored(): void;
}

const LOG_LIMIT = 200;

export function createLogStore(readStored: () => string): LogStore {
  const listeners = new Set<() => void>();
  let nextId = 0;
  let snapshot: LogSnapshot = { entries: [], stored: readStored() };
  const update = (next: LogSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    write: (kind, text) =>
      update({
        ...snapshot,
        entries: [{ id: nextId++, kind, text }, ...snapshot.entries].slice(0, LOG_LIMIT),
      }),
    clear: () => update({ ...snapshot, entries: [] }),
    refreshStored: () => {
      const stored = readStored();
      if (stored !== snapshot.stored) update({ ...snapshot, stored });
    },
  };
}
