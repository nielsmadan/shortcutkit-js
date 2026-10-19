import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  defineContext,
  modifiers,
  type ModifierName,
  type ShortcutDebugEvent,
  type ShortcutInput,
} from '../src';

const key = (
  code: string,
  mods: ModifierName[] = [],
  extra: { readonly repeat?: boolean; readonly editingText?: boolean } = {},
): ShortcutInput => ({ type: 'key', code, modifiers: modifiers(mods), ...extra });

const focusContext = defineContext({
  id: 'editor',
  actions: {
    search: { displayName: 'Search', defaults: 'k' },
    save: { displayName: 'Save', defaults: 'meta+s' },
    escape: { displayName: 'Escape', defaults: 'escape' },
    chord: { displayName: 'Chord', defaults: 'meta+k s' },
  },
});

const repeatContext = defineContext({
  id: 'editor',
  actions: {
    nudge: { displayName: 'Nudge', defaults: 'meta+j' },
    deleteItem: { displayName: 'Delete', defaults: 'meta+d', allowsKeyRepeat: false },
    pick: { displayName: 'Pick', defaults: 'left-click', allowsKeyRepeat: false },
  },
});

const focusRun = async (inputs: ShortcutInput[]) => {
  const registry = await createRegistry({ contexts: [focusContext], platform: 'mac' });
  const fired: string[] = [];
  registry.activate(focusContext, (action) => fired.push(action));
  const results = inputs.map((input) => registry.handleInput(input));
  return { fired, results };
};

const repeatRegistry = async () => {
  const registry = await createRegistry({ contexts: [repeatContext], platform: 'mac' });
  const fired: string[] = [];
  registry.activate(repeatContext, (action) => fired.push(action));
  return { registry, fired };
};

describe('text-input focus gate through the registry', () => {
  it('does not dispatch a bare key while a text field has focus', async () => {
    const { fired, results } = await focusRun([key('KeyK', [], { editingText: true })]);
    expect(results).toEqual(['ignored']);
    expect(fired).toHaveLength(0);
  });

  it('dispatches the same bare key when nothing is being edited', async () => {
    const { fired, results } = await focusRun([key('KeyK')]);
    expect(results).toEqual(['fired']);
    expect(fired).toEqual(['search']);
  });

  it('dispatches a meta shortcut while a text field has focus', async () => {
    const { fired } = await focusRun([key('KeyS', ['meta'], { editingText: true })]);
    expect(fired).toEqual(['save']);
  });

  it('dispatches escape while a text field has focus', async () => {
    const { fired } = await focusRun([key('Escape', [], { editingText: true })]);
    expect(fired).toEqual(['escape']);
  });

  it('completes a chord on a bare second step with a text field focused', async () => {
    const { fired, results } = await focusRun([
      key('KeyK', ['meta'], { editingText: true }),
      key('KeyS', [], { editingText: true }),
    ]);
    expect(results).toEqual(['advanced', 'fired']);
    expect(fired).toEqual(['chord']);
  });
});

describe('key repeat', () => {
  it('fires an action that opts out of repeat once on the initial press', async () => {
    const { registry, fired } = await repeatRegistry();
    expect(registry.handleInput(key('KeyD', ['meta']))).toBe('fired');
    expect(fired).toEqual(['deleteItem']);
  });

  it('does not dispatch repeats of an action that opted out', async () => {
    const { registry, fired } = await repeatRegistry();
    registry.handleInput(key('KeyD', ['meta']));
    registry.handleInput(key('KeyD', ['meta'], { repeat: true }));
    registry.handleInput(key('KeyD', ['meta'], { repeat: true }));
    expect(fired).toEqual(['deleteItem']);
  });

  it('still consumes a suppressed repeat', async () => {
    const { registry } = await repeatRegistry();
    registry.handleInput(key('KeyD', ['meta']));
    expect(registry.handleInput(key('KeyD', ['meta'], { repeat: true }))).toBe('fired');
  });

  it('reports a suppressed repeat to debug listeners', async () => {
    const { registry } = await repeatRegistry();
    const events: ShortcutDebugEvent[] = [];
    registry.onDebugEvent((event) => events.push(event));
    registry.handleInput(key('KeyD', ['meta'], { repeat: true }));
    expect(events.map((event) => event.outcome)).toEqual([
      { type: 'suppressedKeyRepeat', action: { contextId: 'editor', actionId: 'deleteItem' } },
    ]);
  });

  it('dispatches repeats normally for an action that allows them', async () => {
    const { registry, fired } = await repeatRegistry();
    registry.handleInput(key('KeyJ', ['meta']));
    registry.handleInput(key('KeyJ', ['meta'], { repeat: true }));
    registry.handleInput(key('KeyJ', ['meta'], { repeat: true }));
    expect(fired).toEqual(['nudge', 'nudge', 'nudge']);
  });

  it('allows key repeat by default', () => {
    expect(repeatContext.actions.nudge.allowsKeyRepeat).toBe(true);
    expect(repeatContext.actions.deleteItem.allowsKeyRepeat).toBe(false);
  });

  it('dispatches every click of a mouse action that opted out of key repeat', async () => {
    const { registry, fired } = await repeatRegistry();
    const click: ShortcutInput = { type: 'mouse', button: 0, modifiers: modifiers() };
    expect([registry.handleInput(click), registry.handleInput(click)]).toEqual(['fired', 'fired']);
    expect(fired).toEqual(['pick', 'pick']);
  });
});
