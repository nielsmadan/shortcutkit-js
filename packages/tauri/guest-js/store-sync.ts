export interface SyncState {
  readonly known: number;
  readonly seen: number;
  readonly saving: number;
  readonly reading: boolean;
  readonly listeners: number;
}

export type SyncInput =
  | { readonly type: 'subscribed' }
  | { readonly type: 'unsubscribed' }
  | { readonly type: 'announced'; readonly revision: number }
  | { readonly type: 'loaded'; readonly revision: number }
  | { readonly type: 'saveStarted' }
  | { readonly type: 'saveSettled'; readonly revision: number | undefined }
  | { readonly type: 'readResolved'; readonly revision: number; readonly state: unknown }
  | { readonly type: 'readFailed' };

export interface SyncStep {
  readonly state: SyncState;
  readonly read: boolean;
  readonly report: { readonly state: unknown } | undefined;
}

export const initialSyncState: SyncState = {
  known: 0,
  seen: 0,
  saving: 0,
  reading: false,
  listeners: 0,
};

function pump(state: SyncState, report: SyncStep['report']): SyncStep {
  const read =
    state.saving === 0 && !state.reading && state.listeners > 0 && state.seen > state.known;
  return { state: read ? { ...state, reading: true } : state, read, report };
}

function raiseSeen(state: SyncState, revision: number): SyncState {
  return { ...state, seen: Math.max(state.seen, revision) };
}

export function stepSync(state: SyncState, input: SyncInput): SyncStep {
  switch (input.type) {
    case 'subscribed':
      return pump({ ...state, listeners: state.listeners + 1 }, undefined);
    case 'unsubscribed':
      return pump({ ...state, listeners: Math.max(0, state.listeners - 1) }, undefined);
    case 'announced':
      return pump(raiseSeen(state, input.revision), undefined);
    case 'loaded':
      return pump(
        raiseSeen({ ...state, known: Math.max(state.known, input.revision) }, input.revision),
        undefined,
      );
    case 'saveStarted':
      return pump({ ...state, saving: state.saving + 1 }, undefined);
    case 'saveSettled':
      return pump(
        {
          ...state,
          saving: state.saving - 1,
          known: Math.max(state.known, input.revision ?? 0),
          seen: Math.max(state.seen, input.revision ?? 0),
        },
        undefined,
      );
    case 'readResolved': {
      const settled = raiseSeen({ ...state, reading: false }, input.revision);
      const deliver =
        settled.saving === 0 && settled.listeners > 0 && input.revision > settled.known;
      return deliver
        ? pump({ ...settled, known: input.revision }, { state: input.state })
        : pump(settled, undefined);
    }
    case 'readFailed':
      return { state: { ...state, reading: false }, read: false, report: undefined };
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
}
