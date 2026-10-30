// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { ShortcutKitProvider, useShortcutContext } from '../src';
import { editor, macRegistry, pressSave, strictProvider } from './helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function SaveHandler({ onAction }: { readonly onAction: (action: string) => void }) {
  useShortcutContext(editor, onAction);
  return null;
}

describe('ShortcutKitProvider', () => {
  it('attaches input so a bound key dispatches', async () => {
    const registry = await macRegistry();
    const onAction = vi.fn();
    render(<SaveHandler onAction={onAction} />, { wrapper: strictProvider({ registry }) });

    const event = pressSave();

    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves input alone with input={false}', async () => {
    const registry = await macRegistry();
    const onAction = vi.fn();
    render(<SaveHandler onAction={onAction} />, {
      wrapper: strictProvider({ registry, input: false }),
    });

    const event = pressSave();

    expect(onAction).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('passes the input target to attachInput', async () => {
    const registry = await macRegistry();
    const onAction = vi.fn();
    const target = new EventTarget();
    render(<SaveHandler onAction={onAction} />, {
      wrapper: strictProvider({ registry, input: { target } }),
    });

    const outside = pressSave();
    expect(onAction).not.toHaveBeenCalled();
    expect(outside.defaultPrevented).toBe(false);

    pressSave(target);

    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');
  });

  it('forwards stopPropagation to attachInput', async () => {
    const registry = await macRegistry();
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    render(<SaveHandler onAction={() => undefined} />, {
      wrapper: strictProvider({ registry, input: { target: document, stopPropagation: false } }),
    });

    pressSave();
    window.removeEventListener('keydown', onWindow);

    expect(onWindow).toHaveBeenCalledTimes(1);
  });

  it('detaches input when input turns false', async () => {
    const registry = await macRegistry();
    const onAction = vi.fn();
    function App({ input }: { readonly input: boolean }) {
      return (
        <StrictMode>
          <ShortcutKitProvider registry={registry} input={input}>
            <SaveHandler onAction={onAction} />
          </ShortcutKitProvider>
        </StrictMode>
      );
    }
    const { rerender } = render(<App input />);
    pressSave();

    rerender(<App input={false} />);
    const event = pressSave();

    expect(event.defaultPrevented).toBe(false);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');
  });

  it('moves input to a new target', async () => {
    const registry = await macRegistry();
    const onAction = vi.fn();
    const first = new EventTarget();
    const second = new EventTarget();
    function App({ target }: { readonly target: EventTarget }) {
      return (
        <StrictMode>
          <ShortcutKitProvider registry={registry} input={{ target }}>
            <SaveHandler onAction={onAction} />
          </ShortcutKitProvider>
        </StrictMode>
      );
    }
    const { rerender } = render(<App target={first} />);

    rerender(<App target={second} />);
    const stale = pressSave(first);
    pressSave(second);

    expect(stale.defaultPrevented).toBe(false);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');
  });

  it('does not re-attach when re-rendered with an equal inline input object', async () => {
    const registry = await macRegistry();
    const target = new EventTarget();
    const addListener = vi.spyOn(target, 'addEventListener');
    const removeListener = vi.spyOn(target, 'removeEventListener');
    function App({ label }: { readonly label: string }) {
      return (
        <StrictMode>
          <ShortcutKitProvider registry={registry} input={{ target, stopPropagation: false }}>
            {label}
          </ShortcutKitProvider>
        </StrictMode>
      );
    }
    const { rerender, container } = render(<App label="first" />);
    const added = addListener.mock.calls.length;
    const removed = removeListener.mock.calls.length;

    rerender(<App label="second" />);

    expect(container.textContent).toBe('second');
    expect(addListener).toHaveBeenCalledTimes(added);
    expect(removeListener).toHaveBeenCalledTimes(removed);
    expect(added).toBeGreaterThan(removed);
  });
});
