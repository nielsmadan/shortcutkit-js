import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  boundOnly,
  createRegistry,
  defineContext,
  memoryStore,
  modifiers,
  parseShortcut,
  type ModifierName,
  type ShortcutContext,
  type ShortcutInput,
} from '../src';
import { ContextMatcher } from '../src/router';

const sequences = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    openProject: { displayName: 'Open Project', defaults: 'mod+k mod+o' },
    closeProject: { displayName: 'Close Project', defaults: 'mod+k mod+w' },
  },
});

const outer = defineContext({
  id: 'outer',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

const inner = defineContext({
  id: 'inner',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

const visibility = defineContext({
  id: 'visible',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    unbound: { displayName: 'Unbound' },
  },
});

const menu = defineContext({
  id: 'menu',
  scope: 'global',
  actions: { ping: { displayName: 'Ping', defaults: 'ctrl+alt+meta+k' } },
});

const key = (code: string, mods: ModifierName[] = ['meta']): ShortcutInput => ({
  type: 'key',
  code,
  modifiers: modifiers(mods),
});

function make(contexts: readonly ShortcutContext[], stepTimeoutMs?: number) {
  return new ShortcutRegistry({
    contexts,
    platform: 'mac',
    logger: { warn: vi.fn(), error: vi.fn() },
    ...(stepTimeoutMs === undefined ? {} : { stepTimeoutMs }),
  });
}

const activeIds = (registry: ShortcutRegistry) =>
  registry.getSnapshot().activations.map((entry) => entry.contextId);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activation stack', () => {
  it('activating a context pushes it onto the stack', () => {
    const registry = make([sequences]);
    expect(activeIds(registry)).toEqual([]);
    registry.activate(sequences, () => {});
    expect(activeIds(registry)).toEqual(['editor']);
  });

  it('deactivating removes it', () => {
    const registry = make([sequences]);
    const deactivate = registry.activate(sequences, () => {});
    deactivate();
    expect(activeIds(registry)).toEqual([]);
  });

  it('orders activations outermost first, newest innermost', () => {
    const registry = make([outer, inner]);
    registry.activate(outer, () => {});
    registry.activate(inner, () => {});
    expect(activeIds(registry)).toEqual(['outer', 'inner']);
  });

  it('notifies subscribers on activate and deactivate', () => {
    const registry = make([sequences]);
    const listener = vi.fn();
    registry.subscribe(listener);
    const deactivate = registry.activate(sequences, () => {});
    deactivate();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a second call to the same deactivate function leaves other mounts in place', () => {
    const registry = make([sequences]);
    const first = registry.activate(sequences, () => {});
    registry.activate(sequences, () => {});
    first();
    first();
    expect(activeIds(registry)).toEqual(['editor']);
  });

  it('throws for a context that is not registered', () => {
    const registry = make([outer]);
    expect(() => registry.activate(inner, () => {})).toThrow(/not registered/);
  });

  it('a shortcut fires the active handler', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyS'))).toBe('fired');
    expect(fired).toEqual(['save']);
  });

  it('deactivating one mount preserves another mount of the same context', () => {
    const registry = make([sequences]);
    const firedBy: string[] = [];
    const first = registry.activate(sequences, () => firedBy.push('first'));
    registry.activate(sequences, () => firedBy.push('second'));

    first();
    registry.dispatch(sequences, 'save');

    expect(activeIds(registry)).toEqual(['editor']);
    expect(firedBy).toEqual(['second']);
  });

  it('deactivating the newest mount restores routing to the older mount', () => {
    const registry = make([sequences]);
    const firedBy: string[] = [];
    registry.activate(sequences, () => firedBy.push('first'));
    const second = registry.activate(sequences, () => firedBy.push('second'));

    second();
    expect(registry.handleInput(key('KeyS'))).toBe('fired');

    expect(firedBy).toEqual(['first']);
  });

  it('with two mounts of one context, the newest handles the shortcut', () => {
    const registry = make([sequences]);
    const firedBy: string[] = [];
    registry.activate(sequences, () => firedBy.push('first'));
    registry.activate(sequences, () => firedBy.push('second'));
    registry.handleInput(key('KeyS'));
    expect(firedBy).toEqual(['second']);
  });

  it('reload rebuilds active matchers', async () => {
    const store = memoryStore();
    const registry = await createRegistry({ contexts: [sequences], platform: 'mac', store });
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    await store.save({ overrides: { editor: { save: ['shift+meta+s'] } }, preferences: {} });

    expect(await registry.reload()).toEqual({ type: 'reloaded' });
    expect(registry.handleInput(key('KeyS', ['meta', 'shift']))).toBe('fired');
    expect(fired).toEqual(['save']);
  });

  it('an override change rebuilds the active matcher', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));

    registry.setShortcuts(sequences, 'save', [parseShortcut('alt+s', 'mac')]);

    expect(registry.handleInput(key('KeyS'))).toBe('ignored');
    expect(registry.handleInput(key('KeyS', ['alt']))).toBe('fired');
    expect(fired).toEqual(['save']);
  });

  it('a context activated after an override uses the override', () => {
    const registry = make([sequences]);
    registry.setShortcuts(sequences, 'save', [parseShortcut('alt+s', 'mac')]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyS', ['alt']))).toBe('fired');
    expect(fired).toEqual(['save']);
  });
});

describe('matching within one context', () => {
  it('a single-step match fires the action', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyS'))).toBe('fired');
    expect(fired).toEqual(['save']);
  });

  it('a non-matching input is ignored and runs nothing', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyX'))).toBe('ignored');
    expect(fired).toEqual([]);
  });

  it('an inactive context does not match', () => {
    const registry = make([sequences]);
    expect(registry.handleInput(key('KeyS'))).toBe('ignored');
  });

  it('prefix-sharing sequences advance in parallel, then one fires', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));

    expect(registry.handleInput(key('KeyK'))).toBe('advanced');
    expect(fired).toEqual([]);
    expect(registry.handleInput(key('KeyO'))).toBe('fired');
    expect(fired).toEqual(['openProject']);
  });

  it('after one sibling fires, the other has reset', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));

    registry.handleInput(key('KeyK'));
    registry.handleInput(key('KeyO'));

    expect(registry.handleInput(key('KeyW'))).toBe('ignored');
    expect(fired).toEqual(['openProject']);
  });

  it('a wrong second step abandons the sequence', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    registry.handleInput(key('KeyK'));
    expect(registry.handleInput(key('KeyX'))).toBe('ignored');
    expect(registry.handleInput(key('KeyO'))).toBe('ignored');
    expect(fired).toEqual([]);
  });

  it('an unfinished sequence resets after the step timeout', async () => {
    const registry = make([sequences], 500);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    registry.handleInput(key('KeyK'));
    await vi.advanceTimersByTimeAsync(500);
    expect(registry.handleInput(key('KeyO'))).toBe('ignored');
    expect(fired).toEqual([]);
  });

  it('every binding of a multi-binding action fires it', () => {
    const multi = defineContext({
      id: 'multi',
      actions: { save: { displayName: 'Save', defaults: ['mod+s', 'ctrl+s'] } },
    });
    const registry = make([multi]);
    const fired: string[] = [];
    registry.activate(multi, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyS', ['meta']))).toBe('fired');
    expect(registry.handleInput(key('KeyS', ['ctrl']))).toBe('fired');
    expect(fired).toEqual(['save', 'save']);
  });

  it('a mouse binding fires', () => {
    const mouse = defineContext({
      id: 'canvas',
      actions: { pick: { displayName: 'Pick', defaults: 'alt+left-click' } },
    });
    const registry = make([mouse]);
    const fired: string[] = [];
    registry.activate(mouse, (action) => fired.push(action));
    expect(registry.handleInput({ type: 'mouse', button: 0, modifiers: modifiers(['alt']) })).toBe(
      'fired',
    );
    expect(fired).toEqual(['pick']);
  });

  it('ContextMatcher.reset returns every binding to its first step', () => {
    const dispatched: string[] = [];
    const matcher = new ContextMatcher(
      'editor',
      [
        {
          actionId: 'openProject',
          shortcut: parseShortcut('mod+k mod+o', 'mac'),
          allowsKeyRepeat: true,
        },
      ],
      (actionId) => dispatched.push(actionId),
      1000,
    );
    expect(matcher.handle(key('KeyK')).result).toBe('advanced');
    matcher.reset();
    expect(matcher.handle(key('KeyO')).result).toBe('ignored');
    expect(matcher.handle(key('KeyK')).result).toBe('advanced');
    expect(matcher.handle(key('KeyO'))).toEqual({
      result: 'fired',
      action: { contextId: 'editor', actionId: 'openProject' },
      repeatSuppressed: false,
    });
    expect(dispatched).toEqual(['openProject']);
  });
});

describe('routing across the stack', () => {
  it('an empty stack ignores input', () => {
    expect(make([outer]).handleInput(key('KeyS'))).toBe('ignored');
  });

  it('the innermost context wins a tie', () => {
    const registry = make([outer, inner]);
    const fired: string[] = [];
    registry.activate(outer, () => fired.push('outer'));
    registry.activate(inner, () => fired.push('inner'));
    expect(registry.handleInput(key('KeyS'))).toBe('fired');
    expect(fired).toEqual(['inner']);
  });

  it('an outer context fires when the inner one does not match', () => {
    const quitter = defineContext({
      id: 'quitter',
      actions: { quit: { displayName: 'Quit', defaults: 'mod+q' } },
    });
    const registry = make([quitter, inner]);
    const fired: string[] = [];
    registry.activate(quitter, (action) => fired.push(`quitter.${action}`));
    registry.activate(inner, (action) => fired.push(`inner.${action}`));
    expect(registry.handleInput(key('KeyQ'))).toBe('fired');
    expect(fired).toEqual(['quitter.quit']);
  });

  it('an inner advance does not pre-empt: the outer context advances in parallel', () => {
    const innerChord = defineContext({
      id: 'innerChord',
      actions: { open: { displayName: 'Open', defaults: 'mod+k mod+o' } },
    });
    const outerChord = defineContext({
      id: 'outerChord',
      actions: { close: { displayName: 'Close', defaults: 'mod+k mod+w' } },
    });
    const registry = make([outerChord, innerChord]);
    const fired: string[] = [];
    registry.activate(outerChord, (action) => fired.push(action));
    registry.activate(innerChord, (action) => fired.push(action));

    expect(registry.handleInput(key('KeyK'))).toBe('advanced');
    expect(registry.handleInput(key('KeyW'))).toBe('fired');
    expect(fired).toEqual(['close']);
  });

  it("an inner fire resets the outer context's partial sequence", () => {
    const outerChord = defineContext({
      id: 'outerChord',
      actions: { open: { displayName: 'Open', defaults: 'mod+k mod+o' } },
    });
    const innerSave = defineContext({
      id: 'innerSave',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const registry = make([outerChord, innerSave]);
    const fired: string[] = [];
    registry.activate(outerChord, (action) => fired.push(action));
    registry.activate(innerSave, (action) => fired.push(action));

    expect(registry.handleInput(key('KeyK'))).toBe('advanced');
    expect(registry.handleInput(key('KeyS'))).toBe('fired');
    expect(registry.handleInput(key('KeyO'))).toBe('ignored');
    expect(fired).toEqual(['save']);
  });

  it('modifier keydowns are ignored without breaking a sequence', () => {
    const registry = make([sequences]);
    const fired: string[] = [];
    registry.activate(sequences, (action) => fired.push(action));
    expect(registry.handleInput(key('KeyK'))).toBe('advanced');
    expect(registry.handleInput(key('ShiftLeft', ['meta', 'shift']))).toBe('ignored');
    expect(registry.handleInput(key('KeyO'))).toBe('fired');
    expect(fired).toEqual(['openProject']);
  });
});

describe('active bindings and settings visibility', () => {
  it('a deactivated context drops out of activeBindings', () => {
    const registry = make([visibility]);
    const deactivate = registry.activate(visibility, () => {});
    expect(registry.activeBindings().groups.map((group) => group.contextId)).toEqual(['visible']);

    deactivate();
    expect(registry.activeBindings().groups).toEqual([]);
  });

  it('a never-activated context is still reachable through bindings()', () => {
    const registry = make([visibility]);
    const settings = registry.bindings(['visible']);
    expect(settings.groups.map((group) => group.contextId)).toEqual(['visible']);
    expect(settings.groups[0]?.entries.map((entry) => entry.actionId)).toEqual(['save', 'unbound']);
  });

  it('bindings() keeps unbound actions so they can be bound in settings', () => {
    const registry = make([visibility]);
    const entries = registry.bindings(['visible']).groups[0]?.entries ?? [];
    expect(entries.find((entry) => entry.actionId === 'unbound')?.shortcuts).toEqual([]);
  });

  it('bindings() follows registration order, not request order', () => {
    const registry = make([outer, inner]);
    expect(registry.bindings(['inner', 'outer']).groups.map((g) => g.contextId)).toEqual([
      'outer',
      'inner',
    ]);
  });

  it('boundOnly drops unbound actions, which is what the legend renders', () => {
    const registry = make([visibility]);
    registry.activate(visibility, () => {});
    const legend = boundOnly(registry.activeBindings());
    expect(legend.groups[0]?.entries.map((entry) => entry.actionId)).toEqual(['save']);
  });

  it('a global context stays in activeBindings without being activated', () => {
    const registry = make([menu]);
    expect(registry.activeBindings().groups.map((group) => group.contextId)).toEqual(['menu']);
  });

  it('a context activated twice appears once in activeBindings', () => {
    const registry = make([visibility]);
    registry.activate(visibility, () => {});
    registry.activate(visibility, () => {});
    expect(registry.activeBindings().groups.map((group) => group.contextId)).toEqual(['visible']);
  });
});
