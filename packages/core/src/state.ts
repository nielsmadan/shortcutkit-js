export type HintPolicy =
  | { readonly type: 'always' }
  | { readonly type: 'oncePerSession' }
  | { readonly type: 'timeout'; readonly seconds: number };

export function formatHintPolicy(policy: HintPolicy): string {
  switch (policy.type) {
    case 'always':
      return 'always';
    case 'oncePerSession':
      return 'once-per-session';
    case 'timeout':
      return `timeout:${policy.seconds}`;
  }
}

export function parseHintPolicy(text: string): HintPolicy | undefined {
  if (text === 'always') return { type: 'always' };
  if (text === 'once-per-session') return { type: 'oncePerSession' };
  const seconds = /^timeout:(.+)$/.exec(text)?.[1];
  if (seconds === undefined) return undefined;
  const value = Number(seconds);
  return Number.isFinite(value) && value >= 0 ? { type: 'timeout', seconds: value } : undefined;
}

export function sameHintPolicy(a: HintPolicy, b: HintPolicy): boolean {
  return formatHintPolicy(a) === formatHintPolicy(b);
}

export interface Preferences {
  readonly hintsEnabled?: boolean | undefined;
  readonly hintFrequency?: string | undefined;
}

// The persisted form: overrides keyed by context id, then action id, each a list of
// canonical shortcut strings. An empty list means the user unbound the action.
export interface RawState {
  readonly overrides: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly preferences: Preferences;
}

export const EMPTY_STATE: RawState = { overrides: {}, preferences: {} };

export class RawStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawStateError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBindings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new RawStateError(`${path} must be an array of strings`);
  }
  return value;
}

function decodePreferences(value: unknown): Preferences {
  if (!isRecord(value)) return {};
  const hintFrequency =
    typeof value.hintFrequency === 'string' && parseHintPolicy(value.hintFrequency)
      ? value.hintFrequency
      : undefined;
  return {
    ...(typeof value.hintsEnabled === 'boolean' ? { hintsEnabled: value.hintsEnabled } : {}),
    ...(hintFrequency === undefined ? {} : { hintFrequency }),
  };
}

// Accepts whatever a store loaded. A missing file (`undefined`/`null`) is empty
// state; a malformed shape throws. Invalid preferences are dropped rather than
// blocking the overrides.
export function decodeRawState(value: unknown): RawState {
  if (value === undefined || value === null) return EMPTY_STATE;
  if (!isRecord(value)) throw new RawStateError('state must be an object');
  const overrides = value.overrides ?? {};
  if (!isRecord(overrides)) throw new RawStateError('overrides must be an object');
  const decoded = Object.fromEntries(
    Object.entries(overrides).map(([contextId, actions]) => {
      if (!isRecord(actions)) throw new RawStateError(`overrides.${contextId} must be an object`);
      return [
        contextId,
        Object.fromEntries(
          Object.entries(actions).map(([actionId, bindings]) => [
            actionId,
            decodeBindings(bindings, `overrides.${contextId}.${actionId}`),
          ]),
        ),
      ];
    }),
  );
  return { overrides: decoded, preferences: decodePreferences(value.preferences) };
}

function sortedRecord<T, U>(record: Readonly<Record<string, T>>, map: (value: T) => U) {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, map(record[key] as T)]),
  );
}

// A JSON-ready copy with sorted keys, omitting default preferences.
export function encodeRawState(state: RawState): Record<string, unknown> {
  const overrides = sortedRecord(state.overrides, (actions) =>
    sortedRecord(actions, (b) => [...b]),
  );
  return isDefaultPreferences(state.preferences)
    ? { overrides }
    : { overrides, preferences: { ...state.preferences } };
}

export function isDefaultPreferences(preferences: Preferences): boolean {
  return preferences.hintsEnabled === undefined && preferences.hintFrequency === undefined;
}

export function getBindings(
  state: RawState,
  contextId: string,
  actionId: string,
): readonly string[] | undefined {
  return state.overrides[contextId]?.[actionId];
}

function withContext(
  state: RawState,
  contextId: string,
  actions: Readonly<Record<string, readonly string[]>>,
): RawState {
  const { [contextId]: _removed, ...rest } = state.overrides;
  const overrides = Object.keys(actions).length === 0 ? rest : { ...rest, [contextId]: actions };
  return { ...state, overrides };
}

// Stores `bindings` as the action's override, including an empty list (unbound).
export function setOverride(
  state: RawState,
  contextId: string,
  actionId: string,
  bindings: readonly string[],
): RawState {
  return withContext(state, contextId, { ...state.overrides[contextId], [actionId]: bindings });
}

// Removes the action's override, pruning a context left without any.
export function removeOverride(state: RawState, contextId: string, actionId: string): RawState {
  const actions = state.overrides[contextId];
  if (!actions || !(actionId in actions)) return state;
  const { [actionId]: _removed, ...rest } = actions;
  return withContext(state, contextId, rest);
}

// Sets bindings or, for undefined or an empty list, removes the override. This is the
// mutation path for custom migrations.
export function setBindings(
  state: RawState,
  contextId: string,
  actionId: string,
  bindings: readonly string[] | undefined,
): RawState {
  return bindings && bindings.length > 0
    ? setOverride(state, contextId, actionId, bindings)
    : removeOverride(state, contextId, actionId);
}

export function removeContext(state: RawState, contextId: string): RawState {
  return withContext(state, contextId, {});
}

export function contextIds(state: RawState): string[] {
  return Object.keys(state.overrides);
}

export function actionIds(state: RawState, contextId: string): string[] {
  return Object.keys(state.overrides[contextId] ?? {});
}

export function describeRawState(state: RawState): string {
  const lines = Object.keys(state.overrides)
    .sort()
    .flatMap((contextId) => {
      const actions = state.overrides[contextId] ?? {};
      return [
        `[${contextId}]`,
        ...Object.keys(actions)
          .sort()
          .map((actionId) => `  ${actionId} = ${(actions[actionId] ?? []).join(', ')}`),
      ];
    });
  const { hintsEnabled, hintFrequency } = state.preferences;
  const preferences = isDefaultPreferences(state.preferences)
    ? []
    : [
        '[preferences]',
        ...(hintsEnabled === undefined ? [] : [`  hints-enabled = ${hintsEnabled}`]),
        ...(hintFrequency === undefined ? [] : [`  hint-frequency = ${hintFrequency}`]),
      ];
  const all = [...lines, ...preferences];
  return all.length === 0 ? '(no overrides)' : all.join('\n');
}

export function sameRawState(a: RawState, b: RawState): boolean {
  return JSON.stringify(encodeRawState(a)) === JSON.stringify(encodeRawState(b));
}
