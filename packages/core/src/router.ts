import type { ActionRef } from './context';
import { type MatchResult, SequenceMatcher, type ShortcutInput, stepFromInput } from './matcher';
import type { Shortcut, Step } from './shortcut';

export type DebugOutcome =
  // `stackDepth` 0 is the innermost activation, the one that wins ties.
  | { readonly type: 'dispatched'; readonly action: ActionRef; readonly stackDepth: number }
  | { readonly type: 'advanced'; readonly action: ActionRef }
  // Matched, but the action opted out of key repeat; the input is still consumed.
  | { readonly type: 'suppressedKeyRepeat'; readonly action: ActionRef }
  // Also covers keystrokes surrendered to a focused text field.
  | { readonly type: 'noMatch' };

export interface ShortcutDebugEvent {
  readonly pressed: Step;
  readonly outcome: DebugOutcome;
}

export interface ContextMatcherBinding {
  readonly actionId: string;
  readonly shortcut: Shortcut;
  readonly allowsKeyRepeat: boolean;
}

interface ContextOutcome {
  readonly result: MatchResult;
  readonly action?: ActionRef;
  readonly repeatSuppressed?: boolean;
}

export class ContextMatcher {
  readonly contextId: string;
  private readonly dispatch: (actionId: string) => void;
  private readonly stepTimeoutMs: number;
  private bindings: readonly (ContextMatcherBinding & { readonly matcher: SequenceMatcher })[] = [];

  constructor(
    contextId: string,
    bindings: readonly ContextMatcherBinding[],
    dispatch: (actionId: string) => void,
    stepTimeoutMs: number,
  ) {
    this.contextId = contextId;
    this.dispatch = dispatch;
    this.stepTimeoutMs = stepTimeoutMs;
    this.rebuild(bindings);
  }

  rebuild(bindings: readonly ContextMatcherBinding[]): void {
    this.reset();
    this.bindings = bindings.map((binding) => ({
      ...binding,
      matcher: new SequenceMatcher(binding.shortcut, { stepTimeoutMs: this.stepTimeoutMs }),
    }));
  }

  reset(): void {
    this.bindings.forEach((binding) => binding.matcher.reset());
  }

  handle(input: ShortcutInput): ContextOutcome {
    let advanced: ActionRef | undefined;
    for (const binding of this.bindings) {
      const result = binding.matcher.handle(input);
      if (result === 'advanced') advanced ??= this.ref(binding.actionId);
      if (result !== 'fired') continue;
      this.bindings.forEach((other) => other !== binding && other.matcher.reset());
      const repeatSuppressed =
        input.type === 'key' && input.repeat === true && !binding.allowsKeyRepeat;
      if (!repeatSuppressed) this.dispatch(binding.actionId);
      return { result: 'fired', action: this.ref(binding.actionId), repeatSuppressed };
    }
    return advanced ? { result: 'advanced', action: advanced } : { result: 'ignored' };
  }

  private ref(actionId: string): ActionRef {
    return { contextId: this.contextId, actionId };
  }
}

export interface RouterEntry {
  readonly activationId: number;
  readonly matcher: ContextMatcher;
}

// Consults activations innermost first. The first `fired` wins and resets every other
// matcher so a partial sequence cannot linger; `advanced` lets outer contexts advance
// in parallel.
export function routeInput(
  stack: readonly RouterEntry[],
  input: ShortcutInput,
  onDebug: ((event: ShortcutDebugEvent) => void) | undefined,
): MatchResult {
  const emit = (outcome: DebugOutcome) => onDebug?.({ pressed: stepFromInput(input), outcome });
  const innermostFirst = [...stack].reverse();
  let advanced: ActionRef | undefined;
  let didAdvance = false;
  for (const [depth, entry] of innermostFirst.entries()) {
    const outcome = entry.matcher.handle(input);
    if (outcome.result === 'advanced') {
      didAdvance = true;
      advanced ??= outcome.action;
      continue;
    }
    if (outcome.result !== 'fired') continue;
    stack.forEach((other) => other !== entry && other.matcher.reset());
    if (onDebug && outcome.action) {
      emit(
        outcome.repeatSuppressed
          ? { type: 'suppressedKeyRepeat', action: outcome.action }
          : { type: 'dispatched', action: outcome.action, stackDepth: depth },
      );
    }
    return 'fired';
  }
  if (onDebug) emit(advanced ? { type: 'advanced', action: advanced } : { type: 'noMatch' });
  return didAdvance ? 'advanced' : 'ignored';
}
