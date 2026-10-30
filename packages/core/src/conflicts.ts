import type { ContextScope } from './context';
import { type KeyboardLayoutFamily, layoutFamilyOfKey } from './keys';
import { type Shortcut, isPrefixOf, sameShortcut, sameStep } from './shortcut';

export interface Occurrence {
  readonly contextId: string;
  readonly actionId: string;
  readonly shortcut: Shortcut;
}

export type UnsupportedReason = 'multiStepInGlobal' | 'mouseInGlobal';

export type Conflict =
  | { readonly type: 'duplicate'; readonly occurrences: readonly Occurrence[] }
  | {
      readonly type: 'unreachablePrefix';
      readonly blocker: Occurrence;
      readonly blocked: Occurrence;
    }
  | { readonly type: 'systemShared'; readonly occurrence: Occurrence }
  | {
      readonly type: 'menuCollision';
      readonly occurrence: Occurrence;
      readonly menuItemTitle: string;
    }
  | { readonly type: 'shadowedByGlobal'; readonly local: Occurrence; readonly global: Occurrence }
  | {
      readonly type: 'unsupportedInScope';
      readonly occurrence: Occurrence;
      readonly reason: UnsupportedReason;
    }
  | {
      readonly type: 'layoutExclusiveKey';
      readonly occurrence: Occurrence;
      readonly layout: KeyboardLayoutFamily;
    };

export type ConflictSeverity = 'warning' | 'error';

export function conflictOccurrences(conflict: Conflict): readonly Occurrence[] {
  switch (conflict.type) {
    case 'duplicate':
      return conflict.occurrences;
    case 'unreachablePrefix':
      return [conflict.blocker, conflict.blocked];
    case 'shadowedByGlobal':
      return [conflict.local, conflict.global];
    case 'systemShared':
    case 'menuCollision':
    case 'unsupportedInScope':
    case 'layoutExclusiveKey':
      return [conflict.occurrence];
  }
}

// Within one context a duplicate or unreachable prefix is an error; across contexts
// it is a warning, since only one of them may be active.
export function conflictSeverity(conflict: Conflict): ConflictSeverity {
  switch (conflict.type) {
    case 'duplicate':
      return new Set(conflict.occurrences.map((o) => o.contextId)).size === 1 ? 'error' : 'warning';
    case 'unreachablePrefix':
      return conflict.blocker.contextId === conflict.blocked.contextId ? 'error' : 'warning';
    case 'shadowedByGlobal':
    case 'unsupportedInScope':
      return 'error';
    case 'systemShared':
    case 'menuCollision':
    case 'layoutExclusiveKey':
      return 'warning';
  }
}

export interface ConflictAnalysisInput {
  readonly occurrences: readonly Occurrence[];
  readonly mutuallyExclusiveContexts?: readonly (readonly string[])[] | undefined;
  readonly systemShortcuts?: readonly Shortcut[] | undefined;
  readonly contextScopes?: ReadonlyMap<string, ContextScope> | undefined;
}

type Mutex = readonly (readonly string[])[];

function canCoactivate(a: string, b: string, mutex: Mutex): boolean {
  return a === b || !mutex.some((group) => group.includes(a) && group.includes(b));
}

function isSingleStep(occurrence: Occurrence): boolean {
  return occurrence.shortcut.steps.length === 1;
}

function firstStepsMatch(a: Occurrence, b: Occurrence): boolean {
  const [stepA] = a.shortcut.steps;
  const [stepB] = b.shortcut.steps;
  return stepA !== undefined && stepB !== undefined && sameStep(stepA, stepB);
}

function groupBy<T>(items: readonly T[], same: (a: T, b: T) => boolean): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find(
      (candidate) => candidate[0] !== undefined && same(candidate[0], item),
    );
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

function detectDuplicates(occurrences: readonly Occurrence[], mutex: Mutex): Conflict[] {
  return groupBy(occurrences.filter(isSingleStep), firstStepsMatch)
    .filter((group) => group.length > 1)
    .filter((group) => {
      const ids = [...new Set(group.map((o) => o.contextId))];
      return (
        ids.length === 1 ||
        ids.some((a, i) => ids.slice(i + 1).some((b) => canCoactivate(a, b, mutex)))
      );
    })
    .map((group) => ({ type: 'duplicate', occurrences: group }));
}

function detectUnreachablePrefixes(occurrences: readonly Occurrence[], mutex: Mutex): Conflict[] {
  return occurrences.flatMap((blocker) =>
    occurrences
      .filter((blocked) => blocked !== blocker && isPrefixOf(blocker.shortcut, blocked.shortcut))
      .filter((blocked) => canCoactivate(blocker.contextId, blocked.contextId, mutex))
      .map((blocked): Conflict => ({ type: 'unreachablePrefix', blocker, blocked })),
  );
}

function detectSystemShared(
  occurrences: readonly Occurrence[],
  systemShortcuts: readonly Shortcut[],
): Conflict[] {
  return occurrences
    .filter((o) => isSingleStep(o) && o.shortcut.steps[0]?.input.type === 'key')
    .filter((o) => systemShortcuts.some((system) => sameShortcut(system, o.shortcut)))
    .map((occurrence) => ({ type: 'systemShared', occurrence }));
}

function detectShadowedByGlobal(
  occurrences: readonly Occurrence[],
  scopes: ReadonlyMap<string, ContextScope>,
): Conflict[] {
  const singles = occurrences.filter(isSingleStep);
  const locals = singles.filter((o) => scopes.get(o.contextId) === 'local');
  const globals = singles.filter((o) => scopes.get(o.contextId) === 'global');
  return globals.flatMap((global) =>
    locals
      .filter((local) => firstStepsMatch(global, local))
      .map((local): Conflict => ({ type: 'shadowedByGlobal', local, global })),
  );
}

function detectUnsupportedInScope(
  occurrences: readonly Occurrence[],
  scopes: ReadonlyMap<string, ContextScope>,
): Conflict[] {
  return occurrences
    .filter((o) => scopes.get(o.contextId) === 'global')
    .flatMap((occurrence): Conflict[] => {
      const reason = unsupportedInScope(occurrence.shortcut, 'global');
      return reason ? [{ type: 'unsupportedInScope', occurrence, reason }] : [];
    });
}

export function unsupportedInScope(
  shortcut: Shortcut,
  scope: ContextScope,
): UnsupportedReason | undefined {
  if (scope !== 'global') return undefined;
  if (shortcut.steps.length > 1) return 'multiStepInGlobal';
  if (shortcut.steps.some((step) => step.input.type === 'mouse')) return 'mouseInGlobal';
  return undefined;
}

export function describeUnsupported(reason: UnsupportedReason): string {
  switch (reason) {
    case 'multiStepInGlobal':
      return "Global shortcuts can't have more than one step";
    case 'mouseInGlobal':
      return "Global shortcuts can't use mouse buttons";
  }
}

// Matching is by physical key, so these bindings work for whoever recorded them and
// are unreachable on other keyboard hardware.
function detectLayoutExclusiveKeys(occurrences: readonly Occurrence[]): Conflict[] {
  return occurrences.flatMap((occurrence): Conflict[] => {
    const layout = occurrence.shortcut.steps
      .map((step) => (step.input.type === 'key' ? layoutFamilyOfKey(step.input.code) : undefined))
      .find((family) => family !== undefined);
    return layout ? [{ type: 'layoutExclusiveKey', occurrence, layout }] : [];
  });
}

export function analyzeConflicts(input: ConflictAnalysisInput): Conflict[] {
  const mutex = input.mutuallyExclusiveContexts ?? [];
  const scopes = input.contextScopes ?? new Map<string, ContextScope>();
  return [
    ...detectDuplicates(input.occurrences, mutex),
    ...detectUnreachablePrefixes(input.occurrences, mutex),
    ...detectSystemShared(input.occurrences, input.systemShortcuts ?? []),
    ...detectShadowedByGlobal(input.occurrences, scopes),
    ...detectUnsupportedInScope(input.occurrences, scopes),
    ...detectLayoutExclusiveKeys(input.occurrences),
  ];
}

export interface MenuShortcut {
  readonly shortcut: Shortcut;
  readonly title: string;
}

export function detectMenuCollisions(
  occurrences: readonly Occurrence[],
  menuShortcuts: readonly MenuShortcut[],
): Conflict[] {
  return occurrences.filter(isSingleStep).flatMap((occurrence): Conflict[] => {
    const item = menuShortcuts.find((menu) => sameShortcut(menu.shortcut, occurrence.shortcut));
    return item ? [{ type: 'menuCollision', occurrence, menuItemTitle: item.title }] : [];
  });
}

export function describeConflict(conflict: Conflict): string {
  const ref = (o: Occurrence) => `${o.contextId}.${o.actionId}`;
  switch (conflict.type) {
    case 'duplicate':
      return `duplicate trigger across [${conflict.occurrences.map(ref).join(' / ')}]`;
    case 'unreachablePrefix':
      return `[${ref(conflict.blocker)}] blocks prefix of [${ref(conflict.blocked)}]`;
    case 'systemShared':
      return `system collision on [${ref(conflict.occurrence)}]`;
    case 'menuCollision':
      return `menu collision on [${ref(conflict.occurrence)}]`;
    case 'shadowedByGlobal':
      return `[${ref(conflict.global)}] shadows [${ref(conflict.local)}]`;
    case 'unsupportedInScope':
      return `[${ref(conflict.occurrence)}] unsupported in scope (${conflict.reason})`;
    case 'layoutExclusiveKey':
      return `[${ref(conflict.occurrence)}] uses a ${conflict.layout}-only key`;
  }
}
