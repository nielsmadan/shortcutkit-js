import {
  type Conflict,
  type MenuShortcut,
  type Occurrence,
  analyzeConflicts,
  conflictOccurrences,
  conflictSeverity,
  describeConflict,
  detectMenuCollisions,
} from './conflicts';
import type { ActionRef, ContextScope, ShortcutContext } from './context';
import { Emitter } from './emitter';
import { formatShortcut, parseShortcut } from './grammar';
import type { KeyBindingEntry, KeyBindings } from './key-bindings';
import { isModifierKeyCode } from './keys';
import { DEFAULT_STEP_TIMEOUT_MS, type MatchResult, type ShortcutInput } from './matcher';
import { type ShortcutMigration, applyMigrations, applyMigrationsBestEffort } from './migrations';
import { ContextMatcher, type ShortcutDebugEvent, routeInput } from './router';
import type { Platform, Shortcut } from './shortcut';
import {
  EMPTY_STATE,
  type HintPolicy,
  type RawState,
  decodeRawState,
  formatHintPolicy,
  parseHintPolicy,
  removeContext,
  removeOverride,
  sameHintPolicy,
  sameRawState,
  setOverride,
} from './state';

export interface ShortcutStore {
  // Resolves to the persisted JSON value, or undefined when nothing is stored yet.
  load(): Promise<unknown>;
  save(state: RawState): Promise<void>;
}

export interface Logger {
  warn(message: string): void;
  error(message: string): void;
}

export interface RegistryOptions {
  readonly contexts: readonly ShortcutContext[];
  readonly platform: Platform;
  readonly store?: ShortcutStore | undefined;
  readonly migrations?: readonly ShortcutMigration[] | undefined;
  // Groups of context ids that are never active together, so their bindings may overlap.
  readonly mutuallyExclusiveContexts?: readonly (readonly string[])[] | undefined;
  // Single-step shortcuts the OS reserves, for the `systemShared` conflict.
  readonly systemShortcuts?: (() => readonly Shortcut[]) | undefined;
  readonly defaultHintsEnabled?: boolean | undefined;
  readonly defaultHintFrequency?: HintPolicy | undefined;
  readonly stepTimeoutMs?: number | undefined;
  readonly saveDebounceMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface ActivationEntry {
  readonly activationId: number;
  readonly contextId: string;
  readonly displayName: string;
  readonly scope: ContextScope;
}

export interface RegistrySnapshot {
  readonly keyBindings: KeyBindings;
  readonly conflicts: readonly Conflict[];
  readonly hintsEnabled: boolean;
  readonly hintFrequency: HintPolicy;
  // Router order: outermost first. A context activated twice appears twice.
  readonly activations: readonly ActivationEntry[];
}

export interface ActionFiredEvent extends ActionRef {
  readonly source: 'shortcut' | 'programmatic';
}

export type SaveResult =
  | { readonly type: 'saved'; readonly state: RawState }
  | { readonly type: 'failed'; readonly state: RawState; readonly error: unknown };

export type ReloadResult =
  | { readonly type: 'reloaded' }
  | { readonly type: 'reloadedWithWritebackFailure'; readonly error: unknown }
  | { readonly type: 'pendingSaveFailed'; readonly error: unknown }
  | { readonly type: 'loadFailed'; readonly error: unknown }
  | { readonly type: 'migrationFailed'; readonly error: unknown }
  // A local edit landed while the store was being read; the edit wins.
  | { readonly type: 'stale' };

export type ApplyResult =
  | { readonly type: 'applied' }
  // Local edits have not reached the store yet; they win, and their save follows.
  | { readonly type: 'pendingChanges' }
  | { readonly type: 'invalid'; readonly error: unknown }
  | { readonly type: 'migrationFailed'; readonly error: unknown };

export interface BindingId extends ActionRef {
  readonly bindingIndex: number;
}

export interface GlobalBinding {
  readonly id: BindingId;
  readonly shortcut: Shortcut;
}

export type ActionHandler<A extends string> = (action: A) => void;

interface Activation {
  readonly activationId: number;
  readonly context: ShortcutContext;
  readonly handler: ActionHandler<string>;
  readonly matcher: ContextMatcher;
}

export function memoryStore(initial?: unknown): ShortcutStore & { readonly current: unknown } {
  let current = initial;
  return {
    get current() {
      return current;
    },
    load: () => Promise.resolve(current),
    save: (state) => {
      current = state;
      return Promise.resolve();
    },
  };
}

const consoleLogger: Logger = {
  warn: (message) => console.warn(`[shortcutkit] ${message}`),
  error: (message) => console.error(`[shortcutkit] ${message}`),
};

const DEFAULT_HINT_FREQUENCY: HintPolicy = { type: 'oncePerSession' };

function key(contextId: string, actionId: string): string {
  return `${contextId}\u0000${actionId}`;
}

export class ShortcutRegistry {
  readonly platform: Platform;
  readonly contexts: readonly ShortcutContext[];
  readonly defaultHintsEnabled: boolean;
  readonly defaultHintFrequency: HintPolicy;

  private readonly store: ShortcutStore;
  private readonly migrations: readonly ShortcutMigration[];
  private readonly mutex: readonly (readonly string[])[];
  private readonly systemShortcuts: () => readonly Shortcut[];
  private readonly stepTimeoutMs: number;
  private readonly saveDebounceMs: number;
  private readonly logger: Logger;
  private readonly contextsById: ReadonlyMap<string, ShortcutContext>;
  private readonly defaults: ReadonlyMap<string, readonly Shortcut[]>;

  private readonly snapshotListeners = new Emitter<void>();
  private readonly actionFiredEmitter = new Emitter<ActionFiredEvent>();
  private readonly saveResultEmitter = new Emitter<SaveResult>();
  private readonly debugEmitter = new Emitter<ShortcutDebugEvent>();

  private state: RawState = EMPTY_STATE;
  private overrides = new Map<string, readonly Shortcut[]>();
  private readonly warnedBindings = new Set<string>();
  private snapshot: RegistrySnapshot;
  private activations: readonly Activation[] = [];
  private readonly globalHandlers = new Map<string, ActionHandler<string>>();
  private nextActivationId = 1;

  private dirty = false;
  private generation = 0;
  private savesInFlight = 0;
  private saveTimer: TimerHandle | undefined;
  private saveChain: Promise<SaveResult | undefined> = Promise.resolve(undefined);

  constructor(options: RegistryOptions) {
    const ids = options.contexts.map((context) => context.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) throw new Error(`Duplicate context ids: ${duplicates.join(', ')}`);
    const unknown = (options.mutuallyExclusiveContexts ?? [])
      .flat()
      .filter((id) => !ids.includes(id));
    if (unknown.length > 0) {
      throw new Error(
        `mutuallyExclusiveContexts references unknown contexts: ${unknown.join(', ')}`,
      );
    }
    this.platform = options.platform;
    this.contexts = options.contexts;
    this.store = options.store ?? memoryStore();
    this.migrations = options.migrations ?? [];
    this.mutex = options.mutuallyExclusiveContexts ?? [];
    this.systemShortcuts = options.systemShortcuts ?? (() => []);
    this.defaultHintsEnabled = options.defaultHintsEnabled ?? true;
    this.defaultHintFrequency = options.defaultHintFrequency ?? DEFAULT_HINT_FREQUENCY;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.saveDebounceMs = options.saveDebounceMs ?? 250;
    this.logger = options.logger ?? consoleLogger;
    this.contextsById = new Map(options.contexts.map((context) => [context.id, context]));
    this.defaults = new Map(
      options.contexts.flatMap((context) =>
        context.actionIds.map((actionId) => [
          key(context.id, actionId),
          context.actions[actionId]?.defaults.map((text) => parseShortcut(text, this.platform)) ??
            [],
        ]),
      ),
    );
    this.snapshot = this.buildSnapshot();
    this.checkDefaultConflicts();
  }

  // Reads the store once at startup. Migrations run best-effort, and a migrated state
  // is written back.
  async load(): Promise<void> {
    let loaded: RawState;
    try {
      loaded = decodeRawState(await this.store.load());
    } catch (error) {
      this.logger.error(`load failed: ${String(error)}; starting from defaults`);
      loaded = EMPTY_STATE;
    }
    const migrated = applyMigrationsBestEffort(
      loaded,
      this.migrations,
      (error) => this.logger.error(`migration failed: ${String(error)}`),
      (message) => this.logger.warn(message),
    );
    this.replaceState(migrated);
    if (!sameRawState(migrated, loaded)) this.markDirty();
    if (this.dirty) await this.flush();
  }

  // MARK: Store contract

  subscribe = (listener: () => void): (() => void) => this.snapshotListeners.subscribe(listener);

  getSnapshot = (): RegistrySnapshot => this.snapshot;

  onActionFired(listener: (event: ActionFiredEvent) => void): () => void {
    return this.actionFiredEmitter.subscribe(listener);
  }

  onSaveResult(listener: (result: SaveResult) => void): () => void {
    return this.saveResultEmitter.subscribe(listener);
  }

  // Per-input outcomes, for answering "why didn't my shortcut fire". Built only while a
  // listener is attached.
  onDebugEvent(listener: (event: ShortcutDebugEvent) => void): () => void {
    return this.debugEmitter.subscribe(listener);
  }

  // MARK: Lookup

  shortcuts<A extends string>(context: ShortcutContext<A>, action: A): readonly Shortcut[] {
    this.requireContext(context);
    return this.effectiveShortcuts(context.id, action);
  }

  isCustomized<A extends string>(context: ShortcutContext<A>, action: A): boolean {
    this.requireContext(context);
    return this.state.overrides[context.id]?.[action] !== undefined;
  }

  get rawState(): RawState {
    return this.state;
  }

  // Bindings for active local contexts and every global context.
  activeBindings(): KeyBindings {
    const ids = new Set(this.activations.map((activation) => activation.context.id));
    this.contexts.filter((c) => c.scope === 'global').forEach((c) => ids.add(c.id));
    return this.bindings(ids);
  }

  // Bindings for the given contexts in registration order, unbound actions included.
  bindings(contextIds: Iterable<string>): KeyBindings {
    const wanted = new Set(contextIds);
    return {
      groups: this.snapshot.keyBindings.groups.filter((group) => wanted.has(group.contextId)),
    };
  }

  menuCollisions(menuShortcuts: readonly MenuShortcut[]): Conflict[] {
    return detectMenuCollisions(this.currentOccurrences(), menuShortcuts);
  }

  globalBindings(): GlobalBinding[] {
    return this.contexts
      .filter((context) => context.scope === 'global')
      .flatMap((context) =>
        context.actionIds.flatMap((actionId) =>
          this.effectiveShortcuts(context.id, actionId).map((shortcut, bindingIndex) => ({
            id: { contextId: context.id, actionId, bindingIndex },
            shortcut,
          })),
        ),
      );
  }

  // MARK: Mutation

  setShortcuts<A extends string>(
    context: ShortcutContext<A>,
    action: A,
    shortcuts: readonly Shortcut[],
  ): void {
    this.requireAction(context, action);
    this.mutate(setOverride(this.state, context.id, action, shortcuts.map(formatShortcut)));
  }

  // Removes one binding from the effective list, storing the remainder as an override.
  removeShortcut<A extends string>(context: ShortcutContext<A>, action: A, index: number): void {
    const current = this.shortcuts(context, action);
    if (index < 0 || index >= current.length) return;
    this.setShortcuts(
      context,
      action,
      current.filter((_, i) => i !== index),
    );
  }

  reset<A extends string>(context: ShortcutContext<A>, action: A): void {
    this.requireAction(context, action);
    this.mutate(removeOverride(this.state, context.id, action));
  }

  resetContext(context: ShortcutContext): void {
    this.requireContext(context);
    this.mutate(removeContext(this.state, context.id));
  }

  resetAll(): void {
    this.mutate({ ...this.state, overrides: {} });
  }

  // The store keeps a preference only while it differs from the app default.
  setHintsEnabled(value: boolean): void {
    const { hintsEnabled: _old, ...rest } = this.state.preferences;
    const preferences =
      value === this.defaultHintsEnabled ? rest : { ...rest, hintsEnabled: value };
    this.mutate({ ...this.state, preferences });
  }

  setHintFrequency(value: HintPolicy): void {
    const { hintFrequency: _old, ...rest } = this.state.preferences;
    const preferences = sameHintPolicy(value, this.defaultHintFrequency)
      ? rest
      : { ...rest, hintFrequency: formatHintPolicy(value) };
    this.mutate({ ...this.state, preferences });
  }

  // MARK: Activation and dispatch

  // Pushes `context` onto the activation stack; the newest activation is innermost
  // and wins ties. Returns the deactivation function.
  activate<A extends string>(context: ShortcutContext<A>, handler: ActionHandler<A>): () => void {
    this.requireContext(context);
    const activationId = this.nextActivationId++;
    const matcher = new ContextMatcher(
      context.id,
      this.matcherBindings(context),
      (actionId) => this.invoke(context.id, actionId, 'shortcut', activationId),
      this.stepTimeoutMs,
    );
    this.activations = [
      ...this.activations,
      { activationId, context, handler: handler as ActionHandler<string>, matcher },
    ];
    this.publish();
    return () => {
      const remaining = this.activations.filter((a) => a.activationId !== activationId);
      if (remaining.length === this.activations.length) return;
      this.activations = remaining;
      this.publish();
    };
  }

  // The handler for a global context, run whenever its system-wide hotkey fires.
  setGlobalHandler<A extends string>(
    context: ShortcutContext<A>,
    handler: ActionHandler<A>,
  ): () => void {
    this.requireContext(context);
    if (context.scope !== 'global') throw new Error(`Context "${context.id}" is not global`);
    const typed = handler as ActionHandler<string>;
    this.globalHandlers.set(context.id, typed);
    return () => {
      if (this.globalHandlers.get(context.id) === typed) this.globalHandlers.delete(context.id);
    };
  }

  // Feeds one input through the active contexts. `advanced` and `fired` mean the
  // caller should consume the input.
  handleInput(input: ShortcutInput): MatchResult {
    if (input.type === 'key' && isModifierKeyCode(input.code)) return 'ignored';
    const onDebug = this.debugEmitter.hasListeners
      ? (event: ShortcutDebugEvent) => this.debugEmitter.emit(event)
      : undefined;
    return routeInput(this.activations, input, onDebug);
  }

  // Runs the action's handler as if its shortcut fired, and reports it as programmatic.
  dispatch<A extends string>(context: ShortcutContext<A>, action: A): void {
    this.requireAction(context, action);
    this.invoke(context.id, action, 'programmatic');
  }

  // Reports the action as fired without running its handler.
  notify<A extends string>(context: ShortcutContext<A>, action: A): void {
    this.requireAction(context, action);
    this.actionFiredEmitter.emit({
      contextId: context.id,
      actionId: action,
      source: 'programmatic',
    });
  }

  // Dispatch by persistence ids; unknown ids log a warning and do nothing.
  dispatchRef(ref: ActionRef): void {
    if (this.hasAction(ref, 'dispatch')) this.invoke(ref.contextId, ref.actionId, 'programmatic');
  }

  notifyRef(ref: ActionRef): void {
    if (this.hasAction(ref, 'notify'))
      this.actionFiredEmitter.emit({ ...ref, source: 'programmatic' });
  }

  // Entry point for a global hotkey backend. Unknown ids are ignored.
  dispatchGlobal(ref: ActionRef): void {
    if (this.contextsById.get(ref.contextId)?.actions[ref.actionId]) {
      this.invoke(ref.contextId, ref.actionId, 'shortcut');
    }
  }

  // MARK: Persistence

  get hasPendingSave(): boolean {
    return this.dirty;
  }

  // Saves pending changes now instead of after the debounce. Resolves to undefined
  // when nothing was pending.
  flush(): Promise<SaveResult | undefined> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.saveChain = this.saveChain.then(() => this.saveNow());
    return this.saveChain;
  }

  // Re-reads the store after flushing pending changes. Migrations must all succeed; a
  // migrated state is written back.
  async reload(): Promise<ReloadResult> {
    const flushed = await this.flush();
    if (flushed?.type === 'failed') return { type: 'pendingSaveFailed', error: flushed.error };
    const generation = this.generation;
    let loaded: RawState;
    try {
      loaded = decodeRawState(await this.store.load());
    } catch (error) {
      return { type: 'loadFailed', error };
    }
    let migrated: RawState;
    try {
      migrated = applyMigrations(loaded, this.migrations, (message) => this.logger.warn(message));
    } catch (error) {
      return { type: 'migrationFailed', error };
    }
    if (generation !== this.generation || this.dirty) return { type: 'stale' };
    this.replaceState(migrated);
    if (sameRawState(migrated, loaded)) return { type: 'reloaded' };
    this.markDirty();
    const writeback = await this.flush();
    return writeback?.type === 'failed'
      ? { type: 'reloadedWithWritebackFailure', error: writeback.error }
      : { type: 'reloaded' };
  }

  // Applies state pushed from elsewhere, e.g. another window's save. Refused while
  // local edits are pending, since their save will supersede it.
  applyState(value: unknown): ApplyResult {
    if (this.dirty || this.savesInFlight > 0) return { type: 'pendingChanges' };
    let decoded: RawState;
    try {
      decoded = decodeRawState(value);
    } catch (error) {
      return { type: 'invalid', error };
    }
    let migrated: RawState;
    try {
      migrated = applyMigrations(decoded, this.migrations, (message) => this.logger.warn(message));
    } catch (error) {
      return { type: 'migrationFailed', error };
    }
    this.replaceState(migrated);
    if (!sameRawState(migrated, decoded)) this.markDirty();
    return { type: 'applied' };
  }

  // MARK: Internals

  private requireContext(context: ShortcutContext): void {
    if (this.contextsById.get(context.id) !== context) {
      throw new Error(`Context "${context.id}" is not registered with this registry`);
    }
  }

  private requireAction(context: ShortcutContext, action: string): void {
    this.requireContext(context);
    if (!context.actions[action])
      throw new Error(`Context "${context.id}" has no action "${action}"`);
  }

  private hasAction(ref: ActionRef, verb: string): boolean {
    const context = this.contextsById.get(ref.contextId);
    if (!context) {
      this.logger.warn(`${verb} ignored: no context "${ref.contextId}"`);
      return false;
    }
    if (!context.actions[ref.actionId]) {
      this.logger.warn(
        `${verb} ignored: no action "${ref.actionId}" in context "${ref.contextId}"`,
      );
      return false;
    }
    return true;
  }

  private effectiveShortcuts(contextId: string, actionId: string): readonly Shortcut[] {
    const k = key(contextId, actionId);
    return this.overrides.get(k) ?? this.defaults.get(k) ?? [];
  }

  private invoke(
    contextId: string,
    actionId: string,
    source: ActionFiredEvent['source'],
    activationId?: number,
  ): void {
    const handler =
      activationId === undefined
        ? (this.activations.findLast((a) => a.context.id === contextId)?.handler ??
          this.globalHandlers.get(contextId))
        : this.activations.find((a) => a.activationId === activationId)?.handler;
    handler?.(actionId);
    this.actionFiredEmitter.emit({ contextId, actionId, source });
  }

  private matcherBindings(context: ShortcutContext) {
    return context.actionIds.flatMap((actionId) =>
      this.effectiveShortcuts(context.id, actionId).map((shortcut) => ({
        actionId,
        shortcut,
        allowsKeyRepeat: context.actions[actionId]?.allowsKeyRepeat ?? true,
      })),
    );
  }

  private parseOverrides(state: RawState): Map<string, readonly Shortcut[]> {
    const parsed = new Map<string, readonly Shortcut[]>();
    for (const [contextId, actions] of Object.entries(state.overrides)) {
      for (const [actionId, texts] of Object.entries(actions)) {
        const shortcuts = texts.flatMap((text) => {
          try {
            return [parseShortcut(text, this.platform)];
          } catch (error) {
            const warning = `${contextId}.${actionId}: ignoring ${String(error)}`;
            if (!this.warnedBindings.has(warning)) this.logger.warn(warning);
            this.warnedBindings.add(warning);
            return [];
          }
        });
        parsed.set(key(contextId, actionId), shortcuts);
      }
    }
    return parsed;
  }

  private mutate(next: RawState): void {
    if (sameRawState(next, this.state)) return;
    this.replaceState(next);
    this.markDirty();
  }

  private replaceState(next: RawState): void {
    this.state = next;
    this.overrides = this.parseOverrides(next);
    this.activations.forEach((a) => a.matcher.rebuild(this.matcherBindings(a.context)));
    this.publish();
  }

  private markDirty(): void {
    this.dirty = true;
    this.generation += 1;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.saveDebounceMs);
  }

  private async saveNow(): Promise<SaveResult | undefined> {
    if (!this.dirty) return undefined;
    const state = this.state;
    const generation = this.generation;
    this.savesInFlight += 1;
    let result: SaveResult;
    try {
      await this.store.save(state);
      if (generation === this.generation) this.dirty = false;
      result = { type: 'saved', state };
    } catch (error) {
      this.logger.error(`save failed: ${String(error)}`);
      result = { type: 'failed', state, error };
    } finally {
      this.savesInFlight -= 1;
    }
    this.saveResultEmitter.emit(result);
    return result;
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    this.snapshotListeners.emit();
  }

  private currentOccurrences(): Occurrence[] {
    return this.contexts.flatMap((context) =>
      context.actionIds.flatMap((actionId) =>
        this.effectiveShortcuts(context.id, actionId).map((shortcut) => ({
          contextId: context.id,
          actionId,
          shortcut,
        })),
      ),
    );
  }

  private contextScopes(): Map<string, ContextScope> {
    return new Map(this.contexts.map((context) => [context.id, context.scope]));
  }

  private buildSnapshot(): RegistrySnapshot {
    const conflicts = analyzeConflicts({
      occurrences: this.currentOccurrences(),
      mutuallyExclusiveContexts: this.mutex,
      systemShortcuts: this.systemShortcuts(),
      contextScopes: this.contextScopes(),
    });
    const byAction = new Map<string, Conflict[]>();
    for (const conflict of conflicts) {
      const refs = new Set(conflictOccurrences(conflict).map((o) => key(o.contextId, o.actionId)));
      refs.forEach((ref) => byAction.set(ref, [...(byAction.get(ref) ?? []), conflict]));
    }
    const groups = this.contexts.map((context) => ({
      contextId: context.id,
      displayName: context.displayName,
      entries: context.actionIds.map((actionId): KeyBindingEntry => ({
        id: `${context.id}.${actionId}`,
        contextId: context.id,
        actionId,
        displayName: context.actions[actionId]?.displayName ?? actionId,
        description: context.actions[actionId]?.description,
        shortcuts: this.effectiveShortcuts(context.id, actionId),
        isCustomized: this.state.overrides[context.id]?.[actionId] !== undefined,
        conflicts: byAction.get(key(context.id, actionId)) ?? [],
      })),
    }));
    const { hintsEnabled, hintFrequency } = this.state.preferences;
    return {
      keyBindings: { groups },
      conflicts,
      hintsEnabled: hintsEnabled ?? this.defaultHintsEnabled,
      hintFrequency:
        (hintFrequency === undefined ? undefined : parseHintPolicy(hintFrequency)) ??
        this.defaultHintFrequency,
      activations: this.activations.map((a) => ({
        activationId: a.activationId,
        contextId: a.context.id,
        displayName: a.context.displayName,
        scope: a.context.scope,
      })),
    };
  }

  // Conflicts among the declared defaults are a programming error in the app.
  private checkDefaultConflicts(): void {
    const occurrences = this.contexts.flatMap((context) =>
      context.actionIds.flatMap((actionId) =>
        (this.defaults.get(key(context.id, actionId)) ?? []).map((shortcut) => ({
          contextId: context.id,
          actionId,
          shortcut,
        })),
      ),
    );
    const errors = analyzeConflicts({
      occurrences,
      mutuallyExclusiveContexts: this.mutex,
      contextScopes: this.contextScopes(),
    }).filter((conflict) => conflictSeverity(conflict) === 'error');
    if (errors.length > 0) {
      this.logger.error(`default-level conflicts: ${errors.map(describeConflict).join('; ')}`);
    }
  }
}

// Constructs a registry and loads its store.
export async function createRegistry(options: RegistryOptions): Promise<ShortcutRegistry> {
  const registry = new ShortcutRegistry(options);
  await registry.load();
  return registry;
}
