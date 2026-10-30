import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { usLayout, type KeyboardLayout, type ShortcutRegistry } from '@shortcutkit/core';
import { attachInput, type AttachInputOptions } from '@shortcutkit/dom';

export interface LayoutStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): KeyboardLayout;
}

export interface ShortcutKitProviderProps {
  readonly registry: ShortcutRegistry;
  readonly layout?: LayoutStore | undefined;
  readonly input?: boolean | AttachInputOptions | undefined;
  readonly children?: ReactNode | undefined;
}

export interface ShortcutKitValue {
  readonly registry: ShortcutRegistry;
  readonly layout: LayoutStore;
}

const US_LAYOUT_STORE: LayoutStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => usLayout,
};

export const ShortcutKitContext = /* @__PURE__ */ createContext<ShortcutKitValue | undefined>(
  undefined,
);

export function useShortcutKit(): ShortcutKitValue {
  const value = useContext(ShortcutKitContext);
  if (value === undefined) throw new Error('ShortcutKit hooks need a <ShortcutKitProvider>');
  return value;
}

export function useLayoutSnapshot(): KeyboardLayout {
  const { layout } = useShortcutKit();
  // Bound, since an adopter's LayoutStore may be a class whose methods use `this`.
  const subscribe = useCallback((listener: () => void) => layout.subscribe(listener), [layout]);
  const getSnapshot = useCallback(() => layout.getSnapshot(), [layout]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function ShortcutKitProvider({
  registry,
  layout = US_LAYOUT_STORE,
  input = true,
  children,
}: ShortcutKitProviderProps): ReactElement {
  const attach = input !== false;
  const { target, stopPropagation } = typeof input === 'object' ? input : {};

  useEffect(() => {
    if (!attach) return undefined;
    return attachInput(registry, { target, stopPropagation });
  }, [registry, attach, target, stopPropagation]);

  const value = useMemo(() => ({ registry, layout }), [registry, layout]);
  return <ShortcutKitContext.Provider value={value}>{children}</ShortcutKitContext.Provider>;
}
