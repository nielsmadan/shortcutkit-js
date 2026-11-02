// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  defineContext,
  memoryStore,
  type MatchResult,
  type ShortcutDebugEvent,
} from '@shortcutkit/core';
import { attachInput } from '../src';

const init = { bubbles: true, cancelable: true, composed: true } as const;

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeRegistry(result: MatchResult = 'fired') {
  return { handleInput: vi.fn((): MatchResult => result) };
}

function attach(...args: Parameters<typeof attachInput>) {
  const detach = attachInput(...args);
  cleanups.push(detach);
  return detach;
}

function listen(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
  capture = false,
) {
  target.addEventListener(type, listener, { capture });
  cleanups.push(() => target.removeEventListener(type, listener, { capture }));
}

function append<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent: Element = document.body,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  parent.append(element);
  return element;
}

function keydown(target: EventTarget, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { ...init, ...options });
  target.dispatchEvent(event);
  return event;
}

function mouse(target: EventTarget, type: string, options: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { ...init, ...options });
  target.dispatchEvent(event);
  return event;
}

const FOLLOW_UPS = ['mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const;

describe('keyboard', () => {
  it('maps a keydown to a key input', () => {
    const registry = fakeRegistry();
    attach(registry);
    keydown(document.body, { code: 'KeyK', ctrlKey: true, shiftKey: true, repeat: true });
    expect(registry.handleInput).toHaveBeenCalledWith({
      type: 'key',
      code: 'KeyK',
      modifiers: { ctrl: true, alt: false, shift: true, meta: false },
      repeat: true,
      editingText: false,
    });
  });

  it.each(['button', 'input:button', 'input:submit', 'input:reset'])(
    'leaves Enter and Space on %s to native activation',
    (kind) => {
      const registry = fakeRegistry();
      attach(registry);
      const button = kind === 'button' ? append('button') : append('input');
      if (button instanceof HTMLInputElement) button.type = kind.slice('input:'.length);
      const page = vi.fn();
      listen(button, 'keydown', page);
      for (const code of ['Enter', 'Space']) {
        expect(keydown(button, { code }).defaultPrevented).toBe(false);
      }
      expect(page).toHaveBeenCalledTimes(2);
      expect(registry.handleInput).not.toHaveBeenCalled();
    },
  );

  it('routes letter shortcuts and modified Enter on a button', () => {
    const registry = fakeRegistry();
    attach(registry);
    const button = append('button');
    keydown(button, { code: 'KeyE' });
    keydown(button, { code: 'Enter', metaKey: true });
    expect(registry.handleInput.mock.calls).toEqual([
      [expect.objectContaining({ code: 'KeyE' })],
      [
        expect.objectContaining({
          code: 'Enter',
          modifiers: { ctrl: false, alt: false, shift: false, meta: true },
        }),
      ],
    ]);
  });

  it('marks a keydown in a textarea as editing text', () => {
    const registry = fakeRegistry();
    attach(registry);
    keydown(append('textarea'), { code: 'KeyK' });
    expect(registry.handleInput).toHaveBeenCalledWith(
      expect.objectContaining({ editingText: true }),
    );
  });

  it('consumes a keydown the registry fires', () => {
    const page = vi.fn();
    listen(document.body, 'keydown', page);
    attach(fakeRegistry('fired'));
    const event = keydown(document.body, { code: 'KeyK' });
    expect(event.defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
  });

  it('consumes a keydown that advances a sequence', () => {
    attach(fakeRegistry('advanced'));
    expect(keydown(document.body, { code: 'KeyG' }).defaultPrevented).toBe(true);
  });

  it('leaves an ignored keydown to the page', () => {
    const page = vi.fn();
    listen(document.body, 'keydown', page);
    attach(fakeRegistry('ignored'));
    const event = keydown(document.body, { code: 'KeyK' });
    expect(event.defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('stopPropagation: false lets a consumed keydown reach the page', () => {
    const page = vi.fn();
    listen(document.body, 'keydown', page);
    attach(fakeRegistry('fired'), { stopPropagation: false });
    const event = keydown(document.body, { code: 'KeyK' });
    expect(event.defaultPrevented).toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('runs before page capture listeners', () => {
    const order: string[] = [];
    const registry = {
      handleInput: vi.fn((): MatchResult => {
        order.push('registry');
        return 'ignored';
      }),
    };
    attach(registry);
    listen(document.body, 'keydown', () => order.push('page'), true);
    keydown(document.body, { code: 'KeyK' });
    expect(order).toEqual(['registry', 'page']);
  });

  it('skips an event an earlier listener already prevented', () => {
    listen(window, 'keydown', (event) => event.preventDefault(), true);
    const registry = fakeRegistry();
    attach(registry);
    keydown(document.body, { code: 'KeyK' });
    expect(registry.handleInput).not.toHaveBeenCalled();
  });

  it('drops composing keydowns', () => {
    const registry = fakeRegistry();
    attach(registry);
    keydown(document.body, { code: 'KeyK', isComposing: true });
    expect(registry.handleInput).not.toHaveBeenCalled();
  });

  it('drops keyCode 229 keydowns that are not composing', () => {
    const registry = fakeRegistry();
    attach(registry);
    keydown(document.body, { code: 'KeyK', keyCode: 229 });
    expect(registry.handleInput).not.toHaveBeenCalled();
  });

  it('leaves a plain keydown Event to the page', () => {
    const registry = fakeRegistry('fired');
    attach(registry);
    const event = new Event('keydown', init);
    document.body.dispatchEvent(event);
    expect(registry.handleInput).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves a keydown without a code to the page', () => {
    const registry = fakeRegistry('fired');
    attach(registry);
    const event = keydown(document.body, { key: 'Unidentified' });
    expect(registry.handleInput).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('mouse', () => {
  it.each([0, 1, 2, 3, 4])('maps mousedown button %i', (button) => {
    const registry = fakeRegistry();
    attach(registry);
    mouse(document.body, 'mousedown', { button, altKey: true });
    expect(registry.handleInput).toHaveBeenCalledWith({
      type: 'mouse',
      button,
      modifiers: { ctrl: false, alt: true, shift: false, meta: false },
    });
  });

  it('ignores mousedown buttons above 4', () => {
    const registry = fakeRegistry();
    attach(registry);
    mouse(document.body, 'mousedown', { button: 5 });
    expect(registry.handleInput).not.toHaveBeenCalled();
  });

  it('leaves a plain mousedown Event to the page', () => {
    const registry = fakeRegistry('fired');
    attach(registry);
    const event = new Event('mousedown', init);
    document.body.dispatchEvent(event);
    expect(registry.handleInput).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('consumes a mousedown the registry fires', () => {
    const page = vi.fn();
    listen(document.body, 'mousedown', page);
    attach(fakeRegistry('fired'));
    const event = mouse(document.body, 'mousedown', { button: 1 });
    expect(event.defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
  });

  it.each(FOLLOW_UPS)('consumes the %s of a consumed press', (type) => {
    const page = vi.fn();
    listen(document.body, type, page);
    attach(fakeRegistry('fired'));
    mouse(document.body, 'mousedown', { button: 2 });
    expect(mouse(document.body, type, { button: 2 }).defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
  });

  it('consumes a contextmenu reported with button 0 after a consumed button-0 press', () => {
    attach(fakeRegistry('fired'));
    mouse(document.body, 'mousedown', { button: 0, ctrlKey: true });
    expect(mouse(document.body, 'contextmenu', { button: 0 }).defaultPrevented).toBe(true);
  });

  it("a held modifier's repeat keydown keeps the press armed", () => {
    const registry = fakeRegistry('fired');
    attach(registry);
    mouse(document.body, 'mousedown', { button: 2, shiftKey: true });
    registry.handleInput.mockReturnValue('ignored');
    keydown(document.body, { code: 'ShiftLeft', shiftKey: true, repeat: true });
    expect(mouse(document.body, 'contextmenu', { button: 2 }).defaultPrevented).toBe(true);
  });

  it.each([
    ['a first modifier keydown', { code: 'AltLeft', altKey: true }],
    ['a repeating non-modifier keydown', { code: 'KeyA', repeat: true }],
  ])('%s keeps the press armed', (_name, options) => {
    const registry = fakeRegistry('fired');
    attach(registry);
    mouse(document.body, 'mousedown', { button: 0 });
    registry.handleInput.mockReturnValue('ignored');
    keydown(document.body, options);
    expect(mouse(document.body, 'click', { button: 0 }).defaultPrevented).toBe(true);
  });

  it("a non-modifier keydown ends the press's suppression", () => {
    const registry = fakeRegistry('fired');
    attach(registry);
    mouse(document.body, 'mousedown', { button: 0 });
    registry.handleInput.mockReturnValue('ignored');
    keydown(document.body, { code: 'KeyA' });
    expect(mouse(document.body, 'click', { button: 0 }).defaultPrevented).toBe(false);
  });

  it('a new ignored press ends the previous suppression', () => {
    const registry = fakeRegistry('fired');
    attach(registry);
    mouse(document.body, 'mousedown', { button: 2 });
    registry.handleInput.mockReturnValue('ignored');
    mouse(document.body, 'mousedown', { button: 2 });
    expect(mouse(document.body, 'contextmenu', { button: 2 }).defaultPrevented).toBe(false);
  });

  it('a pointerdown whose mousedown was suppressed ends the previous suppression', () => {
    attach(fakeRegistry('fired'));
    mouse(document.body, 'mousedown', { button: 2 });
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(mouse(document.body, 'click', { button: 2 }).defaultPrevented).toBe(false);
  });

  it('a mousedown claimed by an earlier listener ends the previous suppression', () => {
    let claiming = false;
    listen(window, 'mousedown', (event) => claiming && event.preventDefault(), true);
    attach(fakeRegistry('fired'));
    mouse(document.body, 'mousedown', { button: 2 });
    claiming = true;
    mouse(document.body, 'mousedown', { button: 2 });
    expect(mouse(document.body, 'click', { button: 2 }).defaultPrevented).toBe(false);
  });

  it('a keydown claimed by an earlier listener ends the previous suppression', () => {
    let claiming = false;
    listen(window, 'keydown', (event) => claiming && event.preventDefault(), true);
    attach(fakeRegistry('fired'));
    mouse(document.body, 'mousedown', { button: 0 });
    claiming = true;
    keydown(document.body, { code: 'KeyA' });
    expect(mouse(document.body, 'click', { button: 0 }).defaultPrevented).toBe(false);
  });

  it('leaves the follow-up events of an ignored press alone', () => {
    attach(fakeRegistry('ignored'));
    const down = mouse(document.body, 'mousedown', { button: 0 });
    expect(down.defaultPrevented).toBe(false);
    expect(mouse(document.body, 'click', { button: 0 }).defaultPrevented).toBe(false);
  });
});

describe('attachment', () => {
  it('listens on an injected target', () => {
    const root = document.createElement('div');
    const child = document.createElement('span');
    root.append(child);
    const registry = fakeRegistry();
    attach(registry, { target: root });
    keydown(child, { code: 'KeyK' });
    expect(registry.handleInput).toHaveBeenCalledTimes(1);
  });

  it.each(['keydown', 'mousedown', ...FOLLOW_UPS])('detach removes the %s listener', (type) => {
    const registry = fakeRegistry('fired');
    const detachFirst = attach(registry);
    mouse(document.body, 'mousedown', { button: 0 });
    detachFirst();
    registry.handleInput.mockClear();
    const event =
      type === 'keydown'
        ? keydown(document.body, { code: 'KeyK' })
        : mouse(document.body, type, { button: 0 });
    expect(registry.handleInput).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('detach removes exactly the capture listeners it added', () => {
    const target = document.createElement('div');
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    attachInput(fakeRegistry(), { target })();
    expect(remove.mock.calls).toEqual(add.mock.calls);
    expect(remove.mock.calls.map(([type, , options]) => [type, options])).toEqual(
      ['keydown', 'pointerdown', 'mousedown', ...FOLLOW_UPS].map((type) => [
        type,
        { capture: true },
      ]),
    );
  });

  function throwingRegistry() {
    const queued: (() => void)[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      queued.push(callback);
    });
    attach({
      handleInput: vi.fn((): MatchResult => {
        throw new Error('boom');
      }),
    });
    return queued;
  }

  it('consumes the keydown when the action handler throws, and rethrows it', () => {
    const page = vi.fn();
    listen(document.body, 'keydown', page);
    const queued = throwingRegistry();
    const event = keydown(document.body, { code: 'KeyK' });
    expect(event.defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow('boom');
  });

  it('consumes the click after a mousedown whose action handler throws', () => {
    throwingRegistry();
    mouse(document.body, 'mousedown', { button: 0 });
    expect(mouse(document.body, 'click', { button: 0 }).defaultPrevented).toBe(true);
  });
});

describe('with a real registry', () => {
  const list = defineContext({
    id: 'list',
    actions: {
      goToTop: { displayName: 'Go to Top', defaults: 'g g' },
      leave: { displayName: 'Leave', defaults: 'escape' },
    },
  });

  async function realRegistry() {
    const registry = await createRegistry({
      contexts: [list],
      platform: 'mac',
      store: memoryStore(),
    });
    const handler = vi.fn();
    cleanups.push(registry.activate(list, handler));
    attach(registry);
    return { registry, handler };
  }

  it('fires g g and consumes both keydowns', async () => {
    const { handler } = await realRegistry();
    const first = keydown(document.body, { code: 'KeyG' });
    const second = keydown(document.body, { code: 'KeyG' });
    expect(handler).toHaveBeenCalledWith('goToTop');
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
  });

  it('yields a bare key in a text field', async () => {
    const { registry } = await realRegistry();
    const outcomes: ShortcutDebugEvent['outcome']['type'][] = [];
    cleanups.push(registry.onDebugEvent((event) => outcomes.push(event.outcome.type)));
    const event = keydown(append('input'), { code: 'KeyG' });
    expect(outcomes).toEqual(['noMatch']);
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves an unbound key in a text field to the page when a debug listener throws', async () => {
    vi.useFakeTimers();
    const { registry } = await realRegistry();
    cleanups.push(
      registry.onDebugEvent(() => {
        throw new Error('listener');
      }),
    );
    const page = vi.fn();
    listen(document.body, 'keydown', page);
    const event = keydown(append('input'), { code: 'KeyX' });
    expect(event.defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledTimes(1);
    expect(() => vi.runAllTimers()).toThrow('listener');
  });

  it('fires escape in a text field', async () => {
    const { handler } = await realRegistry();
    const event = keydown(append('input'), { code: 'Escape' });
    expect(handler).toHaveBeenCalledWith('leave');
    expect(event.defaultPrevented).toBe(true);
  });
});
