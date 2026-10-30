import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type FocusEventHandler,
} from 'react';
import {
  shortcutLabel,
  type ActionHandler,
  type Conflict,
  type KeyBindings,
  type RegistrySnapshot,
  type Shortcut,
  type ShortcutContext,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { useLatest } from './latest';
import { useLayoutSnapshot, useShortcutKit } from './provider';

export function useRegistry(): ShortcutRegistry {
  return useShortcutKit().registry;
}

export function useRegistrySnapshot(): RegistrySnapshot {
  const registry = useRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

export function useKeyBindings(): KeyBindings {
  return useRegistrySnapshot().keyBindings;
}

export function useConflicts(): readonly Conflict[] {
  return useRegistrySnapshot().conflicts;
}

export function useShortcutLabel(shortcut: Shortcut): string {
  const { platform } = useRegistry();
  const layout = useLayoutSnapshot();
  return shortcutLabel(shortcut, { platform, layout });
}

export function useShortcuts<A extends string>(
  context: ShortcutContext<A>,
  action: A,
): {
  readonly shortcuts: readonly Shortcut[];
  readonly labels: readonly string[];
  readonly isCustomized: boolean;
} {
  const registry = useRegistry();
  const { platform } = registry;
  const { keyBindings } = useRegistrySnapshot();
  const layout = useLayoutSnapshot();
  return useMemo(() => {
    registry.isCustomized(context, action); // throws unless this exact context is registered
    const entry = keyBindings.groups
      .find((group) => group.contextId === context.id)
      ?.entries.find((candidate) => candidate.actionId === action);
    if (entry === undefined) throw new Error(`Context "${context.id}" has no action "${action}"`);
    return {
      shortcuts: entry.shortcuts,
      labels: entry.shortcuts.map((shortcut) => shortcutLabel(shortcut, { platform, layout })),
      isCustomized: entry.isCustomized,
    };
  }, [registry, keyBindings, platform, layout, context, action]);
}

export function useShortcutContext<A extends string>(
  context: ShortcutContext<A>,
  handler: ActionHandler<A>,
  options?: { readonly enabled?: boolean | undefined },
): void {
  const registry = useRegistry();
  const enabled = options?.enabled ?? true;
  const handlerRef = useLatest(handler);

  useEffect(() => {
    if (!enabled) return undefined;
    return registry.activate(context, (action) => handlerRef.current(action));
  }, [registry, context, enabled, handlerRef]);
}

export function useFocusShortcutContext<A extends string>(
  context: ShortcutContext<A>,
  handler: ActionHandler<A>,
): { readonly onFocus: FocusEventHandler; readonly onBlur: FocusEventHandler } {
  const [focused, setFocused] = useState(false);
  useShortcutContext(context, handler, { enabled: focused });

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback((event: FocusEvent) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setFocused(false);
  }, []);
  return useMemo(() => ({ onFocus, onBlur }), [onFocus, onBlur]);
}
