import type { ActionRef } from './context';
import { type RawState, getBindings, removeContext, removeOverride, setOverride } from './state';

// Applied in declaration order on every load, so each must be idempotent. Append new
// migrations; never reorder, change or remove a shipped one.
export type ShortcutMigration =
  | {
      readonly type: 'renameAction';
      readonly context: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly type: 'moveAction'; readonly from: ActionRef; readonly to: ActionRef }
  | { readonly type: 'resetOverride'; readonly context: string; readonly action: string }
  | { readonly type: 'renameContext'; readonly from: string; readonly to: string }
  | { readonly type: 'custom'; readonly apply: (state: RawState) => RawState };

export type MigrationWarning = (message: string) => void;

function move(
  state: RawState,
  from: ActionRef,
  to: ActionRef,
  verb: string,
  warn: MigrationWarning,
): RawState {
  const value = getBindings(state, from.contextId, from.actionId);
  if (value === undefined) return state;
  if (getBindings(state, to.contextId, to.actionId) !== undefined) {
    warn(`${verb}: target ${to.contextId}.${to.actionId} exists; source wins`);
  }
  const removed = removeOverride(state, from.contextId, from.actionId);
  return setOverride(removed, to.contextId, to.actionId, value);
}

export function applyMigration(
  state: RawState,
  migration: ShortcutMigration,
  warn: MigrationWarning = () => {},
): RawState {
  switch (migration.type) {
    case 'renameAction':
      return move(
        state,
        { contextId: migration.context, actionId: migration.from },
        { contextId: migration.context, actionId: migration.to },
        'renameAction',
        warn,
      );
    case 'moveAction':
      return move(state, migration.from, migration.to, 'moveAction', warn);
    case 'resetOverride':
      return removeOverride(state, migration.context, migration.action);
    case 'renameContext': {
      const source = state.overrides[migration.from];
      if (!source) return state;
      const merged = { ...state.overrides[migration.to], ...source };
      const removed = removeContext(state, migration.from);
      return { ...removed, overrides: { ...removed.overrides, [migration.to]: merged } };
    }
    case 'custom':
      return migration.apply(state);
  }
}

// All or nothing: a throwing migration propagates and no partial result escapes.
export function applyMigrations(
  state: RawState,
  migrations: readonly ShortcutMigration[],
  warn?: MigrationWarning,
): RawState {
  return migrations.reduce((current, migration) => applyMigration(current, migration, warn), state);
}

// Skips a throwing migration and carries on with the rest.
export function applyMigrationsBestEffort(
  state: RawState,
  migrations: readonly ShortcutMigration[],
  onError: (error: unknown) => void,
  warn?: MigrationWarning,
): RawState {
  let current = state;
  for (const migration of migrations) {
    try {
      current = applyMigration(current, migration, warn);
    } catch (error) {
      onError(error);
    }
  }
  return current;
}
