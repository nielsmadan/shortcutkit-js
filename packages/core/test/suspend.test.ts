import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  defineContext,
  describeUnsupported,
  keyStep,
  modifiers,
  mouseStep,
  shortcutOf,
  unsupportedInScope,
  type ShortcutDebugEvent,
  type ShortcutInput,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    gg: { displayName: 'Go Top', defaults: 'g g' },
  },
});

const key = (code: string, mods: Parameters<typeof modifiers>[0] = []): ShortcutInput => ({
  type: 'key',
  code,
  modifiers: modifiers(mods),
});

function make(stepTimeoutMs?: number) {
  const registry = new ShortcutRegistry({
    contexts: [editor],
    platform: 'mac',
    stepTimeoutMs,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  const handler = vi.fn();
  registry.activate(editor, handler);
  return { registry, handler };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('suspend', () => {
  it('ignores bound shortcuts until released', () => {
    const { registry, handler } = make();
    const release = registry.suspend();
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('ignored');
    expect(handler).not.toHaveBeenCalled();
    release();
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('fired');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('resets in-progress sequences when taken', () => {
    const { registry, handler } = make();
    expect(registry.handleInput(key('KeyG'))).toBe('advanced');
    expect(vi.getTimerCount()).toBe(1);
    registry.suspend()();
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.handleInput(key('KeyG'))).toBe('advanced');
    expect(handler).not.toHaveBeenCalled();
  });

  it('needs one release per suspension', () => {
    const { registry } = make();
    const first = registry.suspend();
    const second = registry.suspend();
    first();
    expect(registry.isSuspended).toBe(true);
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('ignored');
    second();
    expect(registry.isSuspended).toBe(false);
  });

  it('releases once when the release is called twice', () => {
    const { registry } = make();
    const first = registry.suspend();
    const second = registry.suspend();
    first();
    first();
    expect(registry.isSuspended).toBe(true);
    second();
    expect(registry.isSuspended).toBe(false);
  });

  it('ignores only the inputs a filter accepts', () => {
    const { registry, handler } = make();
    registry.suspend((input) => input.type === 'key' && input.code === 'KeyS');
    expect(registry.isSuspended).toBe(false);
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('ignored');
    expect(registry.handleInput(key('KeyG'))).toBe('advanced');
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('ignored');
    expect(registry.handleInput(key('KeyG'))).toBe('fired');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps a sequence in progress when a filtered suspension is taken', () => {
    const { registry, handler } = make();
    expect(registry.handleInput(key('KeyG'))).toBe('advanced');
    registry.suspend((input) => input.type === 'key' && input.code === 'KeyS');
    expect(registry.handleInput(key('KeyG'))).toBe('fired');
    expect(handler).toHaveBeenCalledExactlyOnceWith('gg');
  });

  it('emits a suspended debug outcome for an input a filter ignores', () => {
    const { registry } = make();
    const events: ShortcutDebugEvent[] = [];
    registry.onDebugEvent((event) => events.push(event));
    registry.suspend((input) => input.type === 'key' && input.code === 'KeyS');
    registry.handleInput(key('KeyS', ['meta']));
    expect(events.map((event) => event.outcome)).toEqual([{ type: 'suspended' }]);
  });

  it('emits a suspended debug outcome', () => {
    const { registry } = make();
    const events: ShortcutDebugEvent[] = [];
    registry.onDebugEvent((event) => events.push(event));
    registry.suspend();
    registry.handleInput(key('KeyS', ['meta']));
    expect(events.map((event) => event.outcome)).toEqual([{ type: 'suspended' }]);
  });

  it('leaves dispatch running', () => {
    const { registry, handler } = make();
    registry.suspend();
    registry.dispatch(editor, 'save');
    expect(handler).toHaveBeenCalledWith('save');
  });

  it('reports isSuspended only for unfiltered suspensions', () => {
    const { registry } = make();
    expect(registry.isSuspended).toBe(false);
    registry.suspend(() => true);
    expect(registry.isSuspended).toBe(false);
    registry.suspend();
    expect(registry.isSuspended).toBe(true);
  });

  it('exposes the step timeout', () => {
    expect(make(1234).registry.stepTimeoutMs).toBe(1234);
  });
});

describe('unsupportedInScope', () => {
  const single = shortcutOf(keyStep('KeyS', modifiers(['meta'])));
  const multi = shortcutOf(keyStep('KeyK', modifiers(['meta'])), keyStep('KeyC'));
  const mouse = shortcutOf(mouseStep(0, modifiers(['meta'])));

  it('returns each reason in global scope', () => {
    expect(unsupportedInScope(multi, 'global')).toBe('multiStepInGlobal');
    expect(unsupportedInScope(mouse, 'global')).toBe('mouseInGlobal');
  });

  it('accepts anything in local scope and single key shortcuts in global scope', () => {
    expect(unsupportedInScope(multi, 'local')).toBeUndefined();
    expect(unsupportedInScope(mouse, 'local')).toBeUndefined();
    expect(unsupportedInScope(single, 'global')).toBeUndefined();
  });

  it('describes each reason', () => {
    expect(describeUnsupported('multiStepInGlobal')).toBe(
      "Global shortcuts can't have more than one step",
    );
    expect(describeUnsupported('mouseInGlobal')).toBe("Global shortcuts can't use mouse buttons");
  });
});
