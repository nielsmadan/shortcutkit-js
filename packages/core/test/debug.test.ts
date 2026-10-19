import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  defineContext,
  keyStep,
  modifiers,
  stepLabel,
  type ModifierName,
  type ShortcutContext,
  type ShortcutDebugEvent,
  type ShortcutInput,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    chord: { displayName: 'Chord', defaults: 'mod+k mod+o' },
    deleteItem: { displayName: 'Delete', defaults: 'mod+d', allowsKeyRepeat: false },
    search: { displayName: 'Search', defaults: 'k' },
  },
});

const key = (
  code: string,
  mods: ModifierName[] = ['meta'],
  extra: { repeat?: boolean; editingText?: boolean } = {},
): ShortcutInput => ({ type: 'key', code, modifiers: modifiers(mods), ...extra });

function make(contexts: readonly ShortcutContext[] = [editor]) {
  return new ShortcutRegistry({
    contexts,
    platform: 'mac',
    logger: { warn: vi.fn(), error: vi.fn() },
  });
}

function recorded(feed: (registry: ShortcutRegistry) => void): ShortcutDebugEvent[] {
  const registry = make();
  const events: ShortcutDebugEvent[] = [];
  registry.onDebugEvent((event) => events.push(event));
  registry.activate(editor, () => {});
  feed(registry);
  return events;
}

const editorRef = (actionId: string) => ({ contextId: 'editor', actionId });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debug events', () => {
  it('a fired shortcut reports the action, its stack depth and the pressed step', () => {
    const events = recorded((registry) => registry.handleInput(key('KeyS')));

    expect(events).toEqual([
      {
        pressed: keyStep('KeyS', modifiers(['meta'])),
        outcome: { type: 'dispatched', action: editorRef('save'), stackDepth: 0 },
      },
    ]);
    expect(events.map((event) => stepLabel(event.pressed, { platform: 'mac' }))).toEqual(['⌘S']);
  });

  it('an unbound key reports noMatch', () => {
    const events = recorded((registry) => registry.handleInput(key('KeyX')));
    expect(events.map((event) => event.outcome)).toEqual([{ type: 'noMatch' }]);
  });

  it("a chord's first step reports advanced", () => {
    const events = recorded((registry) => registry.handleInput(key('KeyK')));
    expect(events.map((event) => event.outcome)).toEqual([
      { type: 'advanced', action: editorRef('chord') },
    ]);
  });

  it('a suppressed key repeat is reported as such', () => {
    const events = recorded((registry) => {
      registry.handleInput(key('KeyD'));
      registry.handleInput(key('KeyD', ['meta'], { repeat: true }));
    });
    expect(events.map((event) => event.outcome)).toEqual([
      { type: 'dispatched', action: editorRef('deleteItem'), stackDepth: 0 },
      { type: 'suppressedKeyRepeat', action: editorRef('deleteItem') },
    ]);
  });

  it('a keystroke surrendered to a focused text field is reported as noMatch', () => {
    const events = recorded((registry) => {
      expect(registry.handleInput(key('KeyK', [], { editingText: true }))).toBe('ignored');
    });
    expect(events.map((event) => event.outcome)).toEqual([{ type: 'noMatch' }]);
  });

  it('a modifier keydown emits no event', () => {
    const events = recorded((registry) => {
      registry.handleInput(key('MetaLeft'));
      registry.handleInput(key('KeyS'));
    });
    expect(events.map((event) => event.outcome.type)).toEqual(['dispatched']);
  });

  it('an outer context firing reports its depth in the stack', () => {
    const inner = defineContext({
      id: 'inner',
      actions: { quit: { displayName: 'Quit', defaults: 'mod+q' } },
    });
    const registry = make([editor, inner]);
    const events: ShortcutDebugEvent[] = [];
    registry.onDebugEvent((event) => events.push(event));
    registry.activate(editor, () => {});
    registry.activate(inner, () => {});

    registry.handleInput(key('KeyS'));

    expect(events.map((event) => event.outcome)).toEqual([
      { type: 'dispatched', action: editorRef('save'), stackDepth: 1 },
    ]);
  });

  it('events reach only listeners attached at the time of the input', () => {
    const registry = make();
    registry.activate(editor, () => {});
    const first: ShortcutDebugEvent[] = [];
    const second: ShortcutDebugEvent[] = [];

    registry.handleInput(key('KeyS'));
    const detach = registry.onDebugEvent((event) => first.push(event));
    registry.handleInput(key('KeyS'));
    detach();
    registry.handleInput(key('KeyS'));
    registry.onDebugEvent((event) => second.push(event));
    registry.handleInput(key('KeyX'));

    expect(first.map((event) => event.outcome.type)).toEqual(['dispatched']);
    expect(second.map((event) => event.outcome.type)).toEqual(['noMatch']);
  });

  it('the debugging walkthrough produces the documented lines', () => {
    const registry = make();
    registry.activate(editor, () => {});
    const lines: string[] = [];

    [...registry.getSnapshot().activations]
      .reverse()
      .forEach((entry) => lines.push(`${entry.contextId} ${entry.activationId}`));

    registry.onDebugEvent((event) => {
      const pressed = stepLabel(event.pressed, { platform: 'mac' });
      switch (event.outcome.type) {
        case 'dispatched':
          lines.push(
            `${pressed} → ${event.outcome.action.actionId} at depth ${event.outcome.stackDepth}`,
          );
          break;
        case 'advanced':
          lines.push(`chord in progress: ${event.outcome.action.actionId}`);
          break;
        case 'suppressedKeyRepeat':
          lines.push(`repeat suppressed: ${event.outcome.action.actionId}`);
          break;
        case 'noMatch':
          lines.push(`nothing matched ${pressed}`);
          break;
      }
    });
    registry.handleInput(key('KeyS'));

    const activationId = registry.getSnapshot().activations[0]?.activationId;
    expect(lines).toEqual([`editor ${activationId}`, '⌘S → save at depth 0']);
  });
});

describe('activation snapshot', () => {
  const outer = defineContext({
    id: 'outer',
    actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
  });
  const inner = defineContext({
    id: 'inner',
    actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
  });

  it('is empty while nothing is active', () => {
    expect(make([outer]).getSnapshot().activations).toEqual([]);
  });

  it('follows router order, outermost first', () => {
    const registry = make([outer, inner]);
    registry.activate(outer, () => {});
    registry.activate(inner, () => {});
    expect(registry.getSnapshot().activations.map((entry) => entry.contextId)).toEqual([
      'outer',
      'inner',
    ]);
  });

  it('lists a context activated twice twice, with distinct ids in activation order', () => {
    const registry = make([outer]);
    registry.activate(outer, () => {});
    registry.activate(outer, () => {});

    const entries = registry.getSnapshot().activations;
    expect(entries.map((entry) => entry.contextId)).toEqual(['outer', 'outer']);
    const ids = entries.map((entry) => entry.activationId);
    expect(new Set(ids).size).toBe(2);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(registry.activeBindings().groups).toHaveLength(1);
  });

  it('deactivating removes only that activation', () => {
    const registry = make([outer]);
    const deactivateFirst = registry.activate(outer, () => {});
    registry.activate(outer, () => {});
    const secondId = registry.getSnapshot().activations[1]?.activationId;

    deactivateFirst();

    expect(registry.getSnapshot().activations.map((entry) => entry.activationId)).toEqual([
      secondId,
    ]);
  });

  it("entries carry the context's display name and scope", () => {
    const shared = defineContext({
      id: 'canvas.shared',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const registry = make([shared]);
    registry.activate(shared, () => {});

    expect(registry.getSnapshot().activations[0]).toMatchObject({
      contextId: 'canvas.shared',
      displayName: 'Canvas / Shared',
      scope: 'local',
    });
  });
});
