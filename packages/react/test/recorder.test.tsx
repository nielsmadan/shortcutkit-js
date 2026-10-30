// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import {
  createRegistry,
  formatShortcut,
  parseShortcut,
  type Shortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { StrictMode, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ShortcutKitProvider,
  ShortcutRecorder,
  useIsRecording,
  useShortcutContext,
  type ShortcutRecorderProps,
} from '../src';
import { editor, macRegistry, pressSave, strictProvider } from './helpers';

let registry: ShortcutRegistry;
let user: UserEvent;

beforeEach(async () => {
  registry = await macRegistry();
  vi.useFakeTimers();
  // Testing Library's asyncWrapper only advances fake timers when a global `jest` exists
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
});

afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event('blur'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderRecorder(props: Partial<ShortcutRecorderProps> = {}) {
  const onChange = vi.fn<(value: Shortcut | undefined) => void>();
  const result = render(
    <ShortcutRecorder value={undefined} onChange={onChange} aria-label="Shortcut" {...props} />,
    { wrapper: strictProvider({ registry }) },
  );
  return { ...result, onChange, field: screen.getByRole('button', { name: 'Shortcut' }) };
}

function wrapperOf(field: HTMLElement): HTMLElement {
  return field.closest('.shortcut-recorder') as HTMLElement;
}

function committed(onChange: ReturnType<typeof vi.fn>): (string | undefined)[] {
  return onChange.mock.calls.map(([value]) =>
    value === undefined ? undefined : formatShortcut(value as Shortcut),
  );
}

function idle() {
  act(() => vi.advanceTimersByTime(registry.stepTimeoutMs));
}

describe('ShortcutRecorder', () => {
  it('starts recording on click and focuses the field', async () => {
    const { field } = renderRecorder();
    expect(wrapperOf(field).dataset).toMatchObject({ recording: 'false', empty: 'true' });
    expect(field.textContent).toBe('Record Shortcut');

    await user.click(field);

    expect(wrapperOf(field).dataset.recording).toBe('true');
    expect(document.activeElement).toBe(field);
    expect(field.textContent).toBe('Record shortcut…');
  });

  it('shows typed steps and commits through onChange after the timeout', async () => {
    const { field, onChange } = renderRecorder();
    await user.click(field);

    await user.keyboard('k');

    expect(field.textContent).toBe('K …');
    idle();
    expect(committed(onChange)).toEqual(['k']);
    expect(wrapperOf(field).dataset.recording).toBe('false');
    expect(document.activeElement).toBe(field);
  });

  it("shows the current value's label while recording with no steps", async () => {
    const { field } = renderRecorder({ value: parseShortcut('mod+s', 'mac') });
    expect(wrapperOf(field).dataset.empty).toBe('false');

    await user.click(field);

    expect(wrapperOf(field).dataset.recording).toBe('true');
    expect(field.textContent).toBe('⌘S');
  });

  it('cancels on Escape without onChange', async () => {
    const { field, onChange } = renderRecorder({ value: parseShortcut('mod+s', 'mac') });
    await user.click(field);

    await user.keyboard('{Escape}');

    expect(wrapperOf(field).dataset.recording).toBe('false');
    expect(field.textContent).toBe('⌘S');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears on Delete with no steps', async () => {
    const { field, onChange } = renderRecorder({ value: parseShortcut('mod+s', 'mac') });
    await user.click(field);

    await user.keyboard('{Delete}');

    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(wrapperOf(field).dataset.recording).toBe('false');
  });

  it('clears through the clear button', async () => {
    const { onChange } = renderRecorder({ value: parseShortcut('mod+s', 'mac') });

    await user.click(screen.getByRole('button', { name: 'Clear shortcut' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('rejects a two-step recording in global scope until an accepted commit', async () => {
    const { field, onChange } = renderRecorder({ scope: 'global' });
    await user.click(field);
    await user.keyboard('ab');
    idle();

    const caption = screen.getByRole('alert');
    expect(caption.textContent).toBe("Global shortcuts can't have more than one step");
    expect(caption.className).toBe('shortcut-recorder-error');
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(caption.id);
    expect(onChange).not.toHaveBeenCalled();

    await user.click(field);
    await user.keyboard('c');
    idle();

    expect(committed(onChange)).toEqual(['c']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field.getAttribute('aria-describedby')?.split(' ')).not.toContain(caption.id);
  });

  it('shows a validate message', async () => {
    const { field, onChange } = renderRecorder({ validate: () => 'Taken' });
    await user.click(field);
    await user.keyboard('k');
    idle();

    expect(screen.getByRole('alert').textContent).toBe('Taken');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('runs validate after the scope rule', async () => {
    const validate = vi.fn((_shortcut: Shortcut) => 'Taken');
    const { field, onChange } = renderRecorder({ scope: 'global', validate });
    await user.click(field);
    await user.keyboard('ab');
    idle();
    expect(screen.getByRole('alert').textContent).toBe(
      "Global shortcuts can't have more than one step",
    );

    await user.click(field);
    await user.keyboard('k');
    idle();

    expect(screen.getByRole('alert').textContent).toBe('Taken');
    expect(validate.mock.calls.map(([shortcut]) => formatShortcut(shortcut))).toEqual(['k']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits through the onChange, scope and validate of the latest render', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { field, rerender } = renderRecorder({ onChange: first });
    rerender(
      <ShortcutRecorder
        value={undefined}
        onChange={second}
        scope="global"
        validate={(shortcut) => (formatShortcut(shortcut) === 'j' ? 'Taken' : undefined)}
        aria-label="Shortcut"
      />,
    );

    await user.click(field);
    await user.keyboard('ab');
    idle();
    expect(screen.getByRole('alert').textContent).toBe(
      "Global shortcuts can't have more than one step",
    );
    await user.click(field);
    await user.keyboard('j');
    idle();
    expect(screen.getByRole('alert').textContent).toBe('Taken');
    await user.click(field);
    await user.keyboard('k');
    idle();

    expect(committed(second)).toEqual(['k']);
    expect(first).not.toHaveBeenCalled();
  });

  it('finalizes on a second click without restarting', async () => {
    const { field, onChange } = renderRecorder();
    await user.click(field);
    await user.keyboard('k');

    await user.click(field);

    expect(committed(onChange)).toEqual(['k']);
    expect(wrapperOf(field).dataset.recording).toBe('false');
  });

  it('cancels a recording when disabled', async () => {
    const onChange = vi.fn();
    const { field, rerender } = renderRecorder({ onChange });
    await user.click(field);

    rerender(
      <ShortcutRecorder value={undefined} onChange={onChange} aria-label="Shortcut" disabled />,
    );

    expect(wrapperOf(field).dataset.recording).toBe('false');
    expect(field).toHaveProperty('disabled', true);
    expect(registry.isSuspended).toBe(false);
  });

  it('applies id and className', () => {
    const { field } = renderRecorder({ id: 'save-recorder', className: 'wide' });

    expect(field.id).toBe('save-recorder');
    expect(wrapperOf(field).className).toBe('shortcut-recorder wide');
  });

  it('focuses the field when start runs without a focusing pointer event', () => {
    const { field } = renderRecorder();
    expect(document.activeElement).not.toBe(field);

    fireEvent.click(field);

    expect(wrapperOf(field).dataset.recording).toBe('true');
    expect(document.activeElement).toBe(field);
  });

  it('shows several steps joined by spaces', async () => {
    const { field } = renderRecorder();
    await user.click(field);

    await user.keyboard('ab');

    expect(field.textContent).toBe('A B …');
  });

  it('uses custom placeholders', async () => {
    const { field } = renderRecorder({ placeholder: 'Unset', recordingPlaceholder: 'Press keys' });
    expect(field.textContent).toBe('Unset');

    await user.click(field);

    expect(field.textContent).toBe('Press keys');
  });

  it('keeps recording when value changes mid-recording', async () => {
    const onChange = vi.fn();
    const { field, rerender } = renderRecorder({ onChange });
    await user.click(field);
    await user.keyboard('k');

    rerender(
      <ShortcutRecorder
        value={parseShortcut('mod+s', 'mac')}
        onChange={onChange}
        aria-label="Shortcut"
      />,
    );

    expect(wrapperOf(field).dataset.recording).toBe('true');
    expect(field.textContent).toBe('K …');
    idle();
    expect(committed(onChange)).toEqual(['k']);
  });

  it('shows the AltGr caption', async () => {
    registry = await createRegistry({ contexts: [editor], platform: 'windows' });
    const { field } = renderRecorder();
    await user.click(field);

    const event = new KeyboardEvent('keydown', {
      code: 'KeyQ',
      key: '@',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    vi.spyOn(event, 'getModifierState').mockImplementation((key) => key === 'AltGraph');
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(screen.getByRole('alert').textContent).toBe("AltGr characters can't be recorded");
  });

  it('shows the AltGr caption again in a session after the clear button dismissed it', async () => {
    registry = await createRegistry({ contexts: [editor], platform: 'windows' });
    function Controlled() {
      const [value, setValue] = useState<Shortcut | undefined>(parseShortcut('ctrl+s', 'windows'));
      return <ShortcutRecorder value={value} onChange={setValue} aria-label="Shortcut" />;
    }
    render(<Controlled />, { wrapper: strictProvider({ registry }) });
    const field = screen.getByRole('button', { name: 'Shortcut' });
    const pressAltGraph = () => {
      const event = new KeyboardEvent('keydown', {
        code: 'KeyQ',
        key: '@',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      vi.spyOn(event, 'getModifierState').mockImplementation((key) => key === 'AltGraph');
      act(() => {
        document.body.dispatchEvent(event);
      });
    };
    await user.click(field);
    pressAltGraph();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Clear shortcut' }));
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(field);
    pressAltGraph();

    expect(screen.getByRole('alert').textContent).toBe("AltGr characters can't be recorded");
  });

  it('keeps focus on the field after the clear button removes itself', async () => {
    function Controlled() {
      const [value, setValue] = useState<Shortcut | undefined>(parseShortcut('mod+s', 'mac'));
      return <ShortcutRecorder value={value} onChange={setValue} aria-label="Shortcut" />;
    }
    render(<Controlled />, { wrapper: strictProvider({ registry }) });
    const clear = screen.getByRole('button', { name: 'Clear shortcut' });
    clear.focus();

    await user.keyboard('{Enter}');

    expect(screen.queryByRole('button', { name: 'Clear shortcut' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Shortcut' }));
  });

  it('hides the clear button while steps are recorded', async () => {
    const { field } = renderRecorder({ value: parseShortcut('mod+s', 'mac') });
    await user.click(field);
    expect(screen.getByRole('button', { name: 'Clear shortcut' })).toBeTruthy();

    await user.keyboard('k');

    expect(screen.queryByRole('button', { name: 'Clear shortcut' })).toBeNull();
  });

  it('removes the rejection caption when the clear button is used', async () => {
    const { field, onChange } = renderRecorder({
      scope: 'global',
      value: parseShortcut('mod+s', 'mac'),
    });
    await user.click(field);
    await user.keyboard('ab');
    idle();
    expect(screen.getByRole('alert').textContent).toBe(
      "Global shortcuts can't have more than one step",
    );

    await user.click(screen.getByRole('button', { name: 'Clear shortcut' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('removes the rejection caption when value changes from outside', async () => {
    const onChange = vi.fn();
    const { field, rerender } = renderRecorder({ onChange, scope: 'global' });
    await user.click(field);
    await user.keyboard('ab');
    idle();
    expect(screen.getByRole('alert')).toBeTruthy();

    rerender(
      <ShortcutRecorder
        value={parseShortcut('mod+s', 'mac')}
        onChange={onChange}
        scope="global"
        aria-label="Shortcut"
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces a repeated rejection again', async () => {
    const { field } = renderRecorder({ scope: 'global' });
    await user.click(field);
    await user.keyboard('ab');
    idle();
    const first = screen.getByRole('alert');

    await user.click(field);
    await user.keyboard('ab');
    idle();

    expect(screen.getByRole('alert')).not.toBe(first);
  });

  it('exposes the value and recording state to assistive technology', async () => {
    const { field } = renderRecorder({ value: parseShortcut('mod+s', 'mac') });
    const description = () =>
      (field.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ');
    expect(description()).toBe('⌘S');
    expect(field.getAttribute('aria-pressed')).toBe('false');

    await user.click(field);
    await user.keyboard('k');

    expect(description()).toBe('K …');
    expect(field.getAttribute('aria-pressed')).toBe('true');
  });

  it('follows a registry change', async () => {
    const next = await macRegistry();
    const ui = (active: ShortcutRegistry) => (
      <StrictMode>
        <ShortcutKitProvider registry={active}>
          <ShortcutRecorder value={undefined} onChange={() => undefined} aria-label="Shortcut" />
        </ShortcutKitProvider>
      </StrictMode>
    );
    const { rerender } = render(ui(registry));
    rerender(ui(next));

    await user.click(screen.getByRole('button', { name: 'Shortcut' }));

    expect(next.isSuspended).toBe(true);
    expect(registry.isSuspended).toBe(false);
  });
});

function Status() {
  return <output>{String(useIsRecording())}</output>;
}

function Bound({ onAction }: { readonly onAction: (action: string) => void }) {
  useShortcutContext(editor, onAction);
  return null;
}

describe('recording with the provider attached', () => {
  it('useIsRecording follows a recording in another component', async () => {
    render(
      <>
        <ShortcutRecorder value={undefined} onChange={() => undefined} aria-label="Shortcut" />
        <Status />
      </>,
      { wrapper: strictProvider({ registry }) },
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Shortcut' }));
    expect(status.textContent).toBe('true');

    await user.keyboard('{Escape}');
    expect(status.textContent).toBe('false');
  });

  it('records a bound shortcut instead of firing it', async () => {
    const onAction = vi.fn();
    const onChange = vi.fn();
    render(
      <>
        <Bound onAction={onAction} />
        <ShortcutRecorder value={undefined} onChange={onChange} aria-label="Shortcut" />
      </>,
      { wrapper: strictProvider({ registry }) },
    );
    await user.click(screen.getByRole('button', { name: 'Shortcut' }));

    await user.keyboard('{Meta>}s{/Meta}');
    idle();

    expect(committed(onChange)).toEqual(['meta+s']);
    expect(onAction).not.toHaveBeenCalled();

    pressSave();
    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');
  });

  it("records in a portal outside the provider's input target", async () => {
    const host = document.body.appendChild(document.createElement('div'));
    const onChange = vi.fn();
    function Portalled() {
      return createPortal(
        <ShortcutRecorder value={undefined} onChange={onChange} aria-label="Shortcut" />,
        document.body,
      );
    }
    render(<Portalled />, {
      container: host,
      wrapper: strictProvider({ registry, input: { target: host } }),
    });
    await user.click(screen.getByRole('button', { name: 'Shortcut' }));

    await user.keyboard('k');
    idle();

    expect(committed(onChange)).toEqual(['k']);
    expect(registry.isSuspended).toBe(false);
    host.remove();
  });

  it('unmounting mid-recording lifts the suspension once the held key is released', async () => {
    const onAction = vi.fn();
    const onChange = vi.fn();
    function App({ show }: { readonly show: boolean }) {
      return (
        <>
          <Bound onAction={onAction} />
          {show && <ShortcutRecorder value={undefined} onChange={onChange} aria-label="Shortcut" />}
        </>
      );
    }
    const { rerender } = render(<App show />, { wrapper: strictProvider({ registry }) });
    await user.click(screen.getByRole('button', { name: 'Shortcut' }));
    await user.keyboard('{Meta>}{s>}');
    expect(registry.isSuspended).toBe(true);

    rerender(<App show={false} />);
    const repeatInit = {
      code: 'KeyS',
      metaKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    };
    const repeat = new KeyboardEvent('keydown', repeatInit);
    document.body.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    expect(onAction).not.toHaveBeenCalled();

    await user.keyboard('{/s}{/Meta}');

    document.body.dispatchEvent(new KeyboardEvent('keydown', repeatInit));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('save');
    expect(onChange).not.toHaveBeenCalled();
  });
});
