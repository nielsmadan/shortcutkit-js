// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import {
  createRegistry,
  defineContext,
  parseShortcut,
  type ShortcutContext,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import {
  useConflicts,
  useFocusShortcutContext,
  useKeyBindings,
  useRegistry,
  useShortcutContext,
  useShortcutLabel,
  useShortcuts,
} from '../src';
import { editor, macRegistry, pressSave, strictProvider } from './helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function activeContexts(registry: ShortcutRegistry) {
  return registry.getSnapshot().activations.map((activation) => activation.contextId);
}

function Handler({
  onAction,
  enabled,
}: {
  readonly onAction: (action: string) => void;
  readonly enabled?: boolean;
}) {
  useShortcutContext(editor, onAction, { enabled });
  return null;
}

describe('useShortcutContext', () => {
  it('fires the latest handler without re-activating', async () => {
    const registry = await macRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Handler onAction={first} />, {
      wrapper: strictProvider({ registry }),
    });
    const activations = registry.getSnapshot().activations;

    rerender(<Handler onAction={second} />);
    pressSave();

    expect(second).toHaveBeenCalledExactlyOnceWith('save');
    expect(first).not.toHaveBeenCalled();
    expect(registry.getSnapshot().activations).toEqual(activations);
    expect(activations).toHaveLength(1);
  });

  it('deactivates on unmount', async () => {
    const registry = await macRegistry();
    const { unmount } = render(<Handler onAction={() => undefined} />, {
      wrapper: strictProvider({ registry }),
    });
    expect(activeContexts(registry)).toEqual(['editor']);

    unmount();

    expect(activeContexts(registry)).toEqual([]);
  });

  it('activates the new context when the context changes', async () => {
    const other = defineContext({
      id: 'other',
      displayName: 'Other',
      actions: { run: { displayName: 'Run', defaults: 'mod+r' } },
    });
    const registry = await createRegistry({ contexts: [editor, other], platform: 'mac' });
    function Scoped({ context }: { readonly context: ShortcutContext<string> }) {
      useShortcutContext(context, () => undefined);
      return null;
    }
    const { rerender } = render(<Scoped context={editor} />, {
      wrapper: strictProvider({ registry }),
    });
    expect(activeContexts(registry)).toEqual(['editor']);

    rerender(<Scoped context={other} />);

    expect(activeContexts(registry)).toEqual(['other']);
  });

  it('deactivates when enabled turns false', async () => {
    const registry = await macRegistry();
    const { rerender } = render(<Handler onAction={() => undefined} />, {
      wrapper: strictProvider({ registry }),
    });
    expect(activeContexts(registry)).toEqual(['editor']);

    rerender(<Handler onAction={() => undefined} enabled={false} />);

    expect(activeContexts(registry)).toEqual([]);
  });
});

function FocusScope({ onAction }: { readonly onAction: (action: string) => void }) {
  const focusProps = useFocusShortcutContext(editor, onAction);
  return (
    <>
      <div {...focusProps}>
        <button>first</button>
        <button>second</button>
      </div>
      <button>outside</button>
    </>
  );
}

describe('useFocusShortcutContext', () => {
  it('activates on focus inside, stays active within, and deactivates on leaving', async () => {
    const registry = await macRegistry();
    const onAction = vi.fn();
    render(<FocusScope onAction={onAction} />, { wrapper: strictProvider({ registry }) });

    act(() => screen.getByText('first').focus());
    const activations = registry.getSnapshot().activations;
    act(() => screen.getByText('second').focus());
    pressSave();

    expect(activeContexts(registry)).toEqual(['editor']);
    expect(registry.getSnapshot().activations).toEqual(activations);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');

    act(() => screen.getByText('outside').focus());

    expect(activeContexts(registry)).toEqual([]);
  });

  it('stays active when blur moves focus to a descendant', async () => {
    const registry = await macRegistry();
    render(<FocusScope onAction={() => undefined} />, { wrapper: strictProvider({ registry }) });
    act(() => screen.getByText('first').focus());
    const activations = registry.getSnapshot().activations;

    fireEvent.focusOut(screen.getByText('first'), { relatedTarget: screen.getByText('second') });

    expect(registry.getSnapshot().activations).toEqual(activations);
    expect(activeContexts(registry)).toEqual(['editor']);
  });

  it('deactivates on unmount while focused', async () => {
    const registry = await macRegistry();
    const { unmount } = render(<FocusScope onAction={() => undefined} />, {
      wrapper: strictProvider({ registry }),
    });
    act(() => screen.getByText('first').focus());
    expect(activeContexts(registry)).toEqual(['editor']);

    unmount();

    expect(activeContexts(registry)).toEqual([]);
  });
});

describe('snapshot hooks', () => {
  it('useShortcuts re-renders with new labels and keeps its result between unrelated renders', async () => {
    const registry = await macRegistry();
    const { result, rerender } = renderHook(() => useShortcuts(editor, 'save'), {
      wrapper: strictProvider({ registry }),
    });
    const initial = result.current;
    expect(initial).toEqual({
      shortcuts: [parseShortcut('mod+s', 'mac')],
      labels: ['⌘S'],
      isCustomized: false,
    });

    rerender();
    expect(result.current).toBe(initial);

    act(() => registry.setShortcuts(editor, 'save', [parseShortcut('mod+shift+s', 'mac')]));

    expect(result.current.labels).toEqual(['⇧⌘S']);
    expect(result.current.isCustomized).toBe(true);
  });

  it('useShortcutLabel uses mac symbols', async () => {
    const registry = await macRegistry();
    const { result } = renderHook(() => useShortcutLabel(parseShortcut('ctrl+alt+k g', 'mac')), {
      wrapper: strictProvider({ registry }),
    });

    expect(result.current).toBe('⌃⌥K G');
  });

  it('useShortcutLabel reads the provider layout', async () => {
    const registry = await macRegistry();
    const qwertz = (code: string) => (code === 'KeyY' ? 'z' : undefined);
    const layout = { subscribe: () => () => undefined, getSnapshot: () => qwertz };
    const { result } = renderHook(() => useShortcutLabel(parseShortcut('mod+y', 'mac')), {
      wrapper: strictProvider({ registry, layout }),
    });

    expect(result.current).toBe('⌘Z');
  });

  it('useShortcutLabel re-renders when the layout store notifies', async () => {
    const registry = await macRegistry();
    let current: (code: string) => string | undefined = (code) =>
      code === 'KeyY' ? 'y' : undefined;
    const listeners = new Set<() => void>();
    const layout = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => current,
    };
    const { result } = renderHook(() => useShortcutLabel(parseShortcut('mod+y', 'mac')), {
      wrapper: strictProvider({ registry, layout }),
    });
    expect(result.current).toBe('⌘Y');

    current = (code: string) => (code === 'KeyY' ? 'z' : undefined);
    act(() => listeners.forEach((listener) => listener()));

    expect(result.current).toBe('⌘Z');
  });

  it('useShortcuts rejects an unregistered context and a different object with a registered id', async () => {
    const registry = await macRegistry();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lookalike = defineContext({
      id: 'editor',
      displayName: 'Editor',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const stranger = defineContext({
      id: 'stranger',
      displayName: 'Stranger',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const wrapper = strictProvider({ registry });

    expect(() => renderHook(() => useShortcuts(lookalike, 'save'), { wrapper })).toThrow(
      'Context "editor" is not registered with this registry',
    );
    expect(() => renderHook(() => useShortcuts(stranger, 'save'), { wrapper })).toThrow(
      'Context "stranger" is not registered with this registry',
    );
  });

  it('useKeyBindings and useConflicts reflect a conflicting override', async () => {
    const registry = await macRegistry();
    const { result } = renderHook(
      () => ({ bindings: useKeyBindings(), conflicts: useConflicts() }),
      {
        wrapper: strictProvider({ registry }),
      },
    );

    act(() => registry.setShortcuts(editor, 'open', [parseShortcut('mod+s', 'mac')]));

    const open = result.current.bindings.groups[0]?.entries.find((e) => e.actionId === 'open');
    expect(open?.isCustomized).toBe(true);
    expect(open?.conflicts.map((conflict) => conflict.type)).toEqual(['duplicate']);
    expect(result.current.conflicts.map((conflict) => conflict.type)).toEqual(['duplicate']);
  });

  it('throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => renderHook(() => useRegistry(), { wrapper: StrictMode })).toThrow(
      'ShortcutKit hooks need a <ShortcutKitProvider>',
    );
  });
});
