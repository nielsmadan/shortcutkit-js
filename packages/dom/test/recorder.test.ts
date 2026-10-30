// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  defineContext,
  formatShortcut,
  memoryStore,
  type Platform,
  type Shortcut,
  type ShortcutDebugEvent,
} from '@shortcutkit/core';
import { attachInput, createShortcutRecorder, recordingStatus, type RecorderOptions } from '../src';

const init = { bubbles: true, cancelable: true, composed: true } as const;

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  window.dispatchEvent(new Event('blur'));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const editor = defineContext({
  id: 'editor',
  actions: {
    record: { displayName: 'Record' },
    jump: { displayName: 'Jump', defaults: 'j' },
  },
});

function append<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent: Element = document.body,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  parent.append(element);
  return element;
}

function keydown(options: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { ...init, ...options });
  target.dispatchEvent(event);
  return event;
}

function keyup(options: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keyup', { ...init, ...options });
  target.dispatchEvent(event);
  return event;
}

function press(options: KeyboardEventInit): void {
  keydown(options);
  keyup(options);
}

function mouse(target: EventTarget, type: string, options: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { ...init, ...options });
  target.dispatchEvent(event);
  return event;
}

interface SetupOptions extends Partial<RecorderOptions> {
  readonly platform?: Platform;
  readonly stepTimeoutMs?: number;
}

async function setup(options: SetupOptions = {}) {
  vi.useFakeTimers();
  const { platform = 'mac', stepTimeoutMs = 1000, ...recorderOptions } = options;
  const registry = await createRegistry({
    contexts: [editor],
    platform,
    stepTimeoutMs,
    store: memoryStore(),
  });
  const handler = vi.fn();
  cleanups.push(registry.activate(editor, handler));
  cleanups.push(attachInput(registry));
  const element = append('button');
  const onCommit = vi.fn((shortcut: Shortcut) =>
    registry.setShortcuts(editor, 'record', [shortcut]),
  );
  const onCancel = vi.fn();
  const onClear = vi.fn();
  const recorder = createShortcutRecorder(registry, {
    onCommit,
    onCancel,
    onClear,
    element,
    ...recorderOptions,
  });
  cleanups.push(() => recorder.destroy());
  return { registry, handler, element, recorder, onCommit, onCancel, onClear };
}

function committed(onCommit: { mock: { calls: Shortcut[][] } }): string[] {
  return onCommit.mock.calls.map(([shortcut]) => formatShortcut(shortcut as Shortcut));
}

describe('recording keys', () => {
  it('commits a single key after the idle timeout', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    press({ code: 'KeyK', ctrlKey: true });
    expect(recorder.getSnapshot().steps).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['ctrl+k']);
    expect(recorder.getSnapshot()).toEqual({ recording: false, steps: [], rejection: undefined });
  });

  it("defaults the idle timeout to the registry's step timeout", async () => {
    const { recorder, onCommit } = await setup({ stepTimeoutMs: 400 });
    recorder.start();
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(399);
    expect(recorder.getSnapshot().recording).toBe(true);
    vi.advanceTimersByTime(1);
    expect(committed(onCommit)).toEqual(['k']);
  });

  it('uses idleTimeoutMs when given', async () => {
    const { recorder, onCommit } = await setup({ idleTimeoutMs: 50 });
    recorder.start();
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(50);
    expect(committed(onCommit)).toEqual(['k']);
  });

  it('commits two keys within the timeout as one two-step shortcut', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    press({ code: 'KeyG' });
    vi.advanceTimersByTime(900);
    press({ code: 'KeyH', shiftKey: true });
    vi.advanceTimersByTime(999);
    expect(recorder.getSnapshot().recording).toBe(true);
    vi.advanceTimersByTime(1);
    expect(committed(onCommit)).toEqual(['g shift+h']);
  });

  it('records nothing for modifier-only presses', async () => {
    const { recorder, onCancel } = await setup();
    recorder.start();
    press({ code: 'ShiftLeft', shiftKey: true });
    const event = keydown({ code: 'MetaLeft', metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(recorder.getSnapshot()).toEqual({ recording: true, steps: [], rejection: undefined });
    recorder.cancel();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('consumes a key repeat without appending it', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    const repeat = keydown({ code: 'KeyK', repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
    expect(recorder.getSnapshot().steps).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['k']);
  });

  it('cancels on Escape', async () => {
    const { recorder, onCommit, onCancel } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    keydown({ code: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().recording).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('records a modified Escape', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    press({ code: 'Escape', shiftKey: true });
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['shift+escape']);
  });

  it('clears on Backspace with no steps', async () => {
    const { recorder, onClear } = await setup();
    recorder.start();
    keydown({ code: 'Backspace' });
    expect(onClear).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().recording).toBe(false);
  });

  it('records a modified Backspace or Delete as the first step', async () => {
    const { recorder, onCommit, onClear } = await setup();
    recorder.start();
    press({ code: 'Delete', shiftKey: true });
    press({ code: 'Backspace', metaKey: true });
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['shift+delete meta+backspace']);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('records Backspace and Delete after a step', async () => {
    const { recorder, onCommit, onClear } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    press({ code: 'Backspace' });
    press({ code: 'Delete' });
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['k backspace delete']);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('records Tab and Enter as steps and consumes them', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    const tab = keydown({ code: 'Tab' });
    keydown({ code: 'Enter' });
    expect(tab.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['tab enter']);
  });

  it('consumes and ignores a non-bindable code', async () => {
    const { recorder } = await setup();
    recorder.start();
    const event = keydown({ code: 'NumpadClear' });
    expect(event.defaultPrevented).toBe(true);
    expect(recorder.getSnapshot()).toEqual({ recording: true, steps: [], rejection: undefined });
  });

  it('ignores a keydown with an empty code', async () => {
    const { recorder } = await setup();
    recorder.start();
    keydown({ code: '', key: 'Unidentified' });
    expect(recorder.getSnapshot()).toEqual({ recording: true, steps: [], rejection: undefined });
  });

  it('leaves an IME keydown to the page', async () => {
    const { recorder } = await setup();
    recorder.start();
    const composing = keydown({ code: 'KeyK', isComposing: true });
    const process = keydown({ code: 'KeyK', keyCode: 229 });
    expect(composing.defaultPrevented).toBe(false);
    expect(process.defaultPrevented).toBe(false);
    expect(recorder.getSnapshot().steps).toEqual([]);
  });
});

describe('AltGraph', () => {
  function altGraphKeydown(options: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { ...init, ...options });
    vi.spyOn(event, 'getModifierState').mockImplementation((key) => key === 'AltGraph');
    document.body.dispatchEvent(event);
    return event;
  }

  it('rejects an AltGr character on Windows', async () => {
    const { recorder, onCommit } = await setup({ platform: 'windows' });
    recorder.start();
    const event = altGraphKeydown({ code: 'KeyQ', key: '@', ctrlKey: true, altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(recorder.getSnapshot()).toEqual({
      recording: true,
      steps: [],
      rejection: { reason: 'altGraph' },
    });
    vi.advanceTimersByTime(1000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('records AltGr on a key that types nothing new on Windows as ctrl+alt', async () => {
    const { recorder, onCommit } = await setup({ platform: 'windows' });
    recorder.start();
    altGraphKeydown({ code: 'Home', key: 'Home' });
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['ctrl+alt+home']);
  });

  it('records AltGr on Space on Windows as ctrl+alt+space', async () => {
    const { recorder, onCommit } = await setup({ platform: 'windows' });
    recorder.start();
    altGraphKeydown({ code: 'Space', key: ' ', ctrlKey: true, altKey: true });
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['ctrl+alt+space']);
  });

  it('rejects AltGr on a key that types nothing new on Linux', async () => {
    const { recorder, onCommit } = await setup({ platform: 'linux' });
    recorder.start();
    altGraphKeydown({ code: 'Home', key: 'Home', ctrlKey: true, altKey: true });
    expect(recorder.getSnapshot()).toEqual({
      recording: true,
      steps: [],
      rejection: { reason: 'altGraph' },
    });
    vi.advanceTimersByTime(1000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('records Option as alt on the Mac', async () => {
    const { recorder, onCommit } = await setup({ platform: 'mac' });
    recorder.start();
    altGraphKeydown({ code: 'KeyQ', key: 'œ', altKey: true });
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['alt+q']);
  });

  it('clears a standing rejection when the recording is cleared', async () => {
    const { recorder, onClear } = await setup({ platform: 'linux' });
    recorder.start();
    altGraphKeydown({ code: 'KeyE', key: '€', ctrlKey: true, altKey: true });
    keydown({ code: 'Backspace' });
    expect(onClear).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot()).toEqual({ recording: false, steps: [], rejection: undefined });
  });

  it('dismisses a rejection and reports the next AltGr character again', async () => {
    const { recorder } = await setup({ platform: 'linux' });
    const listener = vi.fn();
    cleanups.push(recorder.subscribe(listener));
    recorder.start();
    altGraphKeydown({ code: 'KeyE', key: '€', ctrlKey: true, altKey: true });
    const rejected = recorder.getSnapshot();
    recorder.dismissRejection();
    expect(recorder.getSnapshot()).toEqual({ ...rejected, rejection: undefined });
    altGraphKeydown({ code: 'KeyE', key: '€', ctrlKey: true, altKey: true });
    expect(recorder.getSnapshot().rejection).toEqual({ reason: 'altGraph' });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('leaves the snapshot alone when there is no rejection to dismiss', async () => {
    const { recorder } = await setup();
    recorder.start();
    const started = recorder.getSnapshot();
    recorder.dismissRejection();
    expect(recorder.getSnapshot()).toBe(started);
  });

  it('keeps the rejection through a cancel and clears it on the next commit', async () => {
    const { recorder } = await setup({ platform: 'linux' });
    recorder.start();
    altGraphKeydown({ code: 'KeyE', key: '€', ctrlKey: true, altKey: true });
    recorder.cancel();
    expect(recorder.getSnapshot().rejection).toEqual({ reason: 'altGraph' });
    recorder.start();
    expect(recorder.getSnapshot().rejection).toEqual({ reason: 'altGraph' });
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(recorder.getSnapshot().rejection).toBeUndefined();
  });
});

describe('recording mouse buttons', () => {
  const FOLLOW_UPS = ['click', 'auxclick', 'dblclick', 'contextmenu'] as const;

  it('records a middle-button press and consumes its follow-ups', async () => {
    const { recorder, onCommit } = await setup();
    const outside = append('div');
    recorder.start();
    const down = mouse(outside, 'mousedown', { button: 1 });
    const followUps = FOLLOW_UPS.map((type) => mouse(outside, type, { button: 1 }));
    expect(down.defaultPrevented).toBe(true);
    expect(followUps.map((event) => event.defaultPrevented)).toEqual([true, true, true, true]);
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['middle-click']);
  });

  it('records a shift+left press and consumes its follow-ups', async () => {
    const { recorder, onCommit } = await setup();
    const outside = append('div');
    recorder.start();
    mouse(outside, 'mousedown', { button: 0, shiftKey: true });
    const followUps = FOLLOW_UPS.map((type) => mouse(outside, type, { shiftKey: true }));
    expect(followUps.map((event) => event.defaultPrevented)).toEqual([true, true, true, true]);
    expect(recorder.getSnapshot().recording).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(committed(onCommit)).toEqual(['shift+left-click']);
  });

  it('finalizes on a bare left-click inside the element and consumes its click', async () => {
    const { recorder, element, onCommit } = await setup();
    element.addEventListener('click', () => recorder.start());
    recorder.start();
    press({ code: 'KeyK' });
    const down = mouse(element, 'mousedown', { button: 0 });
    expect(committed(onCommit)).toEqual(['k']);
    const click = mouse(element, 'click', { button: 0 });
    expect(down.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(recorder.getSnapshot().recording).toBe(false);
  });

  it('finalizes on a bare left-click outside the element and lets it through', async () => {
    const { recorder, onCommit } = await setup();
    const outside = append('div');
    const page = vi.fn();
    outside.addEventListener('click', page);
    recorder.start();
    press({ code: 'KeyK' });
    const down = mouse(outside, 'mousedown', { button: 0 });
    mouse(outside, 'click', { button: 0 });
    expect(committed(onCommit)).toEqual(['k']);
    expect(down.defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledOnce();
  });

  it('ends as a cancel on a bare left-click with no steps', async () => {
    const { recorder, onCancel, onCommit } = await setup();
    recorder.start();
    mouse(append('div'), 'mousedown', { button: 0 });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('stops consuming follow-ups once a key is pressed after an armed press', async () => {
    const { recorder, element } = await setup();
    recorder.start();
    mouse(element, 'mousedown', { button: 0 });
    keydown({ code: 'Enter' }, element);
    expect(mouse(element, 'click', { button: 0 }).defaultPrevented).toBe(false);
  });

  it('stops consuming follow-ups of a recorded press once a key is pressed', async () => {
    const { recorder } = await setup();
    const outside = append('div');
    recorder.start();
    mouse(outside, 'mousedown', { button: 1 });
    keydown({ code: 'KeyK' });
    expect(mouse(outside, 'click', { button: 1 }).defaultPrevented).toBe(false);
  });
});

describe('focus', () => {
  it('focuses the element on start', async () => {
    const { recorder, element } = await setup();
    recorder.start();
    expect(document.activeElement).toBe(element);
  });

  it('finalizes when focus leaves the element', async () => {
    const { recorder, onCommit } = await setup();
    const other = append('button');
    recorder.start();
    press({ code: 'KeyK' });
    other.focus();
    expect(committed(onCommit)).toEqual(['k']);
  });

  it('keeps recording when focus moves within the element', async () => {
    const element = append('div');
    element.tabIndex = -1;
    const inner = append('button', element);
    const { recorder } = await setup({ element });
    recorder.start();
    press({ code: 'KeyK' });
    inner.focus();
    expect(recorder.getSnapshot().recording).toBe(true);
  });

  it('finalizes on window blur and when the page is hidden', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    window.dispatchEvent(new Event('blur'));
    recorder.start();
    press({ code: 'KeyJ' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(committed(onCommit)).toEqual(['k', 'j']);
  });

  it('finalizes when the page is hidden through pagehide', async () => {
    const { recorder, onCommit } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    window.dispatchEvent(new Event('pagehide'));
    expect(committed(onCommit)).toEqual(['k']);
  });

  it('finalizes on window blur when the target is the document', async () => {
    const { recorder, onCommit } = await setup({ target: document });
    recorder.start();
    press({ code: 'KeyK' });
    window.dispatchEvent(new Event('blur'));
    expect(committed(onCommit)).toEqual(['k']);
  });

  it('finalizes when focus leaves an element inside a shadow root', async () => {
    const host = append('div');
    const root = host.attachShadow({ mode: 'open' });
    const inside = append('button', root as unknown as Element);
    const other = append('button');
    const { recorder, onCommit } = await setup({ element: inside });
    recorder.start();
    press({ code: 'KeyK' });
    other.focus();
    expect(committed(onCommit)).toEqual(['k']);
  });
});

describe('validation', () => {
  it('publishes a rejection and does not commit', async () => {
    const { recorder, onCommit } = await setup({
      validate: (shortcut) => (shortcut.steps.length > 1 ? 'Too long' : undefined),
    });
    recorder.start();
    press({ code: 'KeyG' });
    press({ code: 'KeyG' });
    vi.advanceTimersByTime(1000);
    const { recording, rejection } = recorder.getSnapshot();
    expect(recording).toBe(false);
    expect(rejection?.reason === 'invalid' && rejection.message).toBe('Too long');
    expect(rejection?.reason === 'invalid' && formatShortcut(rejection.shortcut)).toBe('g g');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ends the session and rethrows when validate throws', async () => {
    const queued: (() => void)[] = [];
    const { recorder, registry, onCommit } = await setup({
      validate: () => {
        throw new Error('broken');
      },
    });
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      queued.push(callback);
    });
    recorder.start();
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    const { recording, rejection } = recorder.getSnapshot();
    expect(recording).toBe(false);
    expect(rejection?.reason === 'invalid' && rejection.message).toBe('broken');
    expect(registry.isSuspended).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow('broken');
  });
});

describe('registry suspension', () => {
  it('suspends the registry while recording, so attachInput leaves a bound key alone', async () => {
    const { recorder, registry, handler } = await setup();
    const outcomes: ShortcutDebugEvent['outcome']['type'][] = [];
    cleanups.push(registry.onDebugEvent((event) => outcomes.push(event.outcome.type)));
    recorder.start();
    expect(registry.isSuspended).toBe(true);
    press({ code: 'KeyJ' });
    expect(outcomes).toEqual(['suspended']);
    expect(handler).not.toHaveBeenCalled();
    recorder.cancel();
    expect(registry.isSuspended).toBe(false);
  });
});

describe('held keys after a session', () => {
  it('swallows repeats of the held key until its keyup, while other keys fire', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    const repeat = keydown({ code: 'KeyK', repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    press({ code: 'KeyJ' });
    expect(handler).toHaveBeenCalledWith('jump');
    const release = keyup({ code: 'KeyK' });
    expect(release.defaultPrevented).toBe(true);
    keydown({ code: 'KeyK', repeat: true });
    expect(handler).toHaveBeenLastCalledWith('record');
  });

  it('stops consuming follow-ups after a key is pressed, once a click armed the guard', async () => {
    const { recorder, element } = await setup();
    recorder.start();
    mouse(element, 'mousedown', { button: 0 });
    vi.advanceTimersByTime(1000);
    expect(mouse(element, 'click', { button: 0 }).defaultPrevented).toBe(true);
    keydown({ code: 'Enter' }, element);
    expect(mouse(element, 'click', { button: 0 }).defaultPrevented).toBe(false);
  });

  it('lets a fresh press of the held key fire', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    keydown({ code: 'KeyK' });
    expect(handler).toHaveBeenCalledWith('record');
  });

  it('ends the guard on a modifier keyup', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'MetaLeft', metaKey: true });
    keydown({ code: 'KeyK', metaKey: true });
    vi.advanceTimersByTime(1000);
    expect(keydown({ code: 'KeyK', metaKey: true, repeat: true }).defaultPrevented).toBe(true);
    keyup({ code: 'MetaLeft' });
    keydown({ code: 'KeyK', metaKey: true, repeat: true });
    expect(handler).toHaveBeenCalledWith('record');
  });

  it('ends the guard on window blur', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(keydown({ code: 'KeyK', repeat: true }).defaultPrevented).toBe(true);
    window.dispatchEvent(new Event('blur'));
    keydown({ code: 'KeyK', repeat: true });
    expect(handler).toHaveBeenCalledWith('record');
  });

  it('ends the guard when the page is hidden', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(keydown({ code: 'KeyK', repeat: true }).defaultPrevented).toBe(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    keydown({ code: 'KeyK', repeat: true });
    expect(handler).toHaveBeenCalledWith('record');
  });

  it('ends the guard on pagehide', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(keydown({ code: 'KeyK', repeat: true }).defaultPrevented).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    keydown({ code: 'KeyK', repeat: true });
    expect(handler).toHaveBeenCalledWith('record');
  });

  it.each(['pointerdown', 'mousedown'])(
    'stops consuming follow-ups after a %s, once a click armed the guard',
    async (type) => {
      const { recorder, element } = await setup();
      const outside = append('div');
      recorder.start();
      mouse(element, 'mousedown', { button: 0 });
      vi.advanceTimersByTime(1000);
      mouse(outside, type, { button: 0 });
      expect(mouse(outside, 'click', { button: 0 }).defaultPrevented).toBe(false);
    },
  );

  it('lets repeats of a held key fire once it is pressed afresh', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    keydown({ code: 'NumpadClear' });
    keydown({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    keydown({ code: 'KeyK' });
    expect(handler).toHaveBeenCalledExactlyOnceWith('record');
    keydown({ code: 'KeyK', repeat: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('holds nothing for a key released during the session', async () => {
    const { recorder, handler } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    keydown({ code: 'KeyK', repeat: true });
    expect(handler).toHaveBeenCalledWith('record');
  });

  it('never holds CapsLock', async () => {
    const { recorder } = await setup();
    recorder.start();
    keydown({ code: 'CapsLock' });
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(keyup({ code: 'CapsLock' }).defaultPrevented).toBe(false);
  });

  it('never holds ScrollLock', async () => {
    const { recorder } = await setup();
    recorder.start();
    keydown({ code: 'ScrollLock' });
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(keyup({ code: 'ScrollLock' }).defaultPrevented).toBe(false);
  });

  it('outlives destroy', async () => {
    const { recorder } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    recorder.destroy();
    expect(keyup({ code: 'KeyK' }).defaultPrevented).toBe(true);
  });
});

describe('lifecycle', () => {
  it('cancels on destroy and starts again afterwards', async () => {
    const { recorder, registry, onCancel } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    recorder.destroy();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().recording).toBe(false);
    expect(registry.isSuspended).toBe(false);
    recorder.start();
    expect(recorder.getSnapshot().recording).toBe(true);
  });

  it('ignores start while already recording', async () => {
    const { recorder, registry, onCancel } = await setup();
    recorder.start();
    press({ code: 'KeyK' });
    recorder.start();
    expect(recorder.getSnapshot().steps).toHaveLength(1);
    recorder.cancel();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(registry.isSuspended).toBe(false);
  });

  it('constructs without touching the registry', async () => {
    const { registry } = await setup();
    const suspend = vi.spyOn(registry, 'suspend');
    createShortcutRecorder(registry, { onCommit: vi.fn() });
    expect(suspend).not.toHaveBeenCalled();
  });

  it('lets onCommit start another recorder', async () => {
    const { registry, recorder, onCancel } = await setup();
    const second = createShortcutRecorder(registry, { onCommit: vi.fn() });
    cleanups.push(() => second.destroy());
    recorder.setOptions({ onCommit: () => second.start(), onCancel });
    recorder.start();
    press({ code: 'KeyK' });
    vi.advanceTimersByTime(1000);
    expect(second.getSnapshot().recording).toBe(true);
    expect(recordingStatus(registry).getSnapshot()).toBe(true);
    expect(registry.isSuspended).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels the first recorder when a second one starts', async () => {
    const { registry, recorder, onCancel, onCommit } = await setup();
    const second = createShortcutRecorder(registry, { onCommit: vi.fn() });
    cleanups.push(() => second.destroy());
    recorder.start();
    press({ code: 'KeyK' });
    second.start();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().recording).toBe(false);
    expect(second.getSnapshot().recording).toBe(true);
    expect(registry.isSuspended).toBe(true);
    expect(recordingStatus(registry).getSnapshot()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('consumes the keyup of a key held during the session', async () => {
    const { recorder } = await setup();
    recorder.start();
    keydown({ code: 'KeyK' });
    expect(keyup({ code: 'KeyK' }).defaultPrevented).toBe(true);
  });

  it.each(['onCommit', 'onCancel', 'onClear'] as const)(
    'ends the session and rethrows when %s throws',
    async (callback) => {
      const queued: (() => void)[] = [];
      const { recorder, registry } = await setup({
        [callback]: () => {
          throw new Error('boom');
        },
      });
      vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => {
        queued.push(fn);
      });
      recorder.start();
      if (callback === 'onCommit') press({ code: 'KeyK' });
      if (callback === 'onClear') press({ code: 'Backspace' });
      if (callback === 'onCancel') press({ code: 'Escape' });
      vi.advanceTimersByTime(1000);
      expect(recorder.getSnapshot().recording).toBe(false);
      expect(registry.isSuspended).toBe(false);
      expect(queued).toHaveLength(1);
      expect(() => queued[0]?.()).toThrow('boom');
    },
  );

  it('releases every listener when a preempted recorder starts a third', async () => {
    const { registry, recorder } = await setup();
    const third = createShortcutRecorder(registry, { onCommit: vi.fn() });
    cleanups.push(() => third.destroy());
    const second = createShortcutRecorder(registry, { onCommit: vi.fn() });
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    recorder.setOptions({ onCommit: vi.fn(), onCancel: () => third.start() });
    recorder.start();
    second.start();
    third.destroy();
    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
    expect(second.getSnapshot().recording).toBe(false);
    expect(registry.isSuspended).toBe(false);
  });

  it('reads options when each event arrives', async () => {
    const { recorder } = await setup();
    const onCommit = vi.fn();
    recorder.start();
    press({ code: 'KeyK' });
    recorder.setOptions({ onCommit });
    vi.advanceTimersByTime(1000);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('reports recording status per registry', async () => {
    const { registry, recorder } = await setup();
    const status = recordingStatus(registry);
    const listener = vi.fn();
    cleanups.push(status.subscribe(listener));
    expect(recordingStatus(registry)).toBe(status);
    recorder.start();
    expect(status.getSnapshot()).toBe(true);
    recorder.cancel();
    expect(status.getSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns the same snapshot until the state changes', async () => {
    const { recorder } = await setup();
    const listener = vi.fn();
    cleanups.push(recorder.subscribe(listener));
    const idle = recorder.getSnapshot();
    expect(recorder.getSnapshot()).toBe(idle);
    recorder.start();
    const started = recorder.getSnapshot();
    expect(started).not.toBe(idle);
    expect(recorder.getSnapshot()).toBe(started);
    press({ code: 'KeyK' });
    expect(recorder.getSnapshot()).not.toBe(started);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
