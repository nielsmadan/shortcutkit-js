import { parseShortcut } from './grammar';

export type ContextScope = 'local' | 'global';

export interface ActionDefinition {
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly defaults?: string | readonly string[] | undefined;
  // `false` fires a held key once instead of repeating: for actions where each
  // invocation costs something, like deletions, toggles and sends.
  readonly allowsKeyRepeat?: boolean | undefined;
}

export interface ResolvedActionDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly defaults: readonly string[];
  readonly allowsKeyRepeat: boolean;
}

export interface ShortcutContext<A extends string = string> {
  readonly id: string;
  readonly scope: ContextScope;
  readonly displayName: string;
  readonly includeInSettings: boolean;
  readonly actionIds: readonly A[];
  readonly actions: Readonly<Record<A, ResolvedActionDefinition>>;
}

export interface ContextOptions<A extends string> {
  readonly id: string;
  readonly scope?: ContextScope | undefined;
  readonly displayName?: string | undefined;
  readonly includeInSettings?: boolean | undefined;
  readonly actions: Readonly<Record<A, ActionDefinition>>;
}

function deriveContextDisplayName(id: string): string {
  return id
    .split('.')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' / ');
}

// Action and context ids are persistence keys: rename them only through a migration.
// Actions keep declaration order; avoid integer-like action ids, which objects reorder.
export function defineContext<const A extends string>(
  options: ContextOptions<A>,
): ShortcutContext<A> {
  const actionIds = Object.keys(options.actions) as A[];
  const entries = actionIds.map((id): [A, ResolvedActionDefinition] => {
    const definition: ActionDefinition = options.actions[id];
    const defaults =
      typeof definition.defaults === 'string' ? [definition.defaults] : (definition.defaults ?? []);
    defaults.forEach((text) => parseShortcut(text, 'mac'));
    return [
      id,
      {
        id,
        displayName: definition.displayName,
        description: definition.description,
        defaults,
        allowsKeyRepeat: definition.allowsKeyRepeat ?? true,
      },
    ];
  });
  return {
    id: options.id,
    scope: options.scope ?? 'local',
    displayName: options.displayName ?? deriveContextDisplayName(options.id),
    includeInSettings: options.includeInSettings ?? true,
    actionIds,
    actions: Object.fromEntries(entries) as Record<A, ResolvedActionDefinition>,
  };
}

export interface ActionRef {
  readonly contextId: string;
  readonly actionId: string;
}
