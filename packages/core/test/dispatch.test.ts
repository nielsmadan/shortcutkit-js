import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  defineContext,
  formatShortcut,
  modifiers,
  parseShortcut,
  type ActionFiredEvent,
  type ShortcutContext,
  type ShortcutInput,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    undo: { displayName: 'Undo', defaults: 'mod+z' },
    deleteItem: { displayName: 'Delete', defaults: 'mod+d', allowsKeyRepeat: false },
  },
});

const global = defineContext({
  id: 'global',
  scope: 'global',
  actions: {
    ping: { displayName: 'Ping', defaults: 'ctrl+alt+meta+k' },
    pong: { displayName: 'Pong' },
  },
});

const local = defineContext({
  id: 'local',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

function make(contexts: readonly ShortcutContext[] = [editor, global]) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const registry = new ShortcutRegistry({ contexts, platform: 'mac', logger });
  const events: ActionFiredEvent[] = [];
  registry.onActionFired((event) => events.push(event));
  return { registry, logger, events };
}

const metaKey = (code: string, repeat = false): ShortcutInput => ({
  type: 'key',
  code,
  modifiers: modifiers(['meta']),
  repeat,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('programmatic dispatch', () => {
  it('dispatch runs the active handler and reports a programmatic event', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.activate(editor, (action) => ran.push(action));

    registry.dispatch(editor, 'save');

    expect(ran).toEqual(['save']);
    expect(events).toEqual([{ contextId: 'editor', actionId: 'save', source: 'programmatic' }]);
  });

  it('dispatch reaches a global handler', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.setGlobalHandler(global, (action) => ran.push(action));

    registry.dispatch(global, 'ping');

    expect(ran).toEqual(['ping']);
    expect(events).toEqual([{ contextId: 'global', actionId: 'ping', source: 'programmatic' }]);
  });

  it('dispatch of an inactive local context still reports the event', () => {
    const { registry, events } = make();
    registry.dispatch(editor, 'undo');
    expect(events).toEqual([{ contextId: 'editor', actionId: 'undo', source: 'programmatic' }]);
  });

  it('dispatchRef routes by persistence ids the same way', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.setGlobalHandler(global, (action) => ran.push(action));
    registry.activate(editor, (action) => ran.push(action));

    registry.dispatchRef({ contextId: 'global', actionId: 'pong' });
    registry.dispatchRef({ contextId: 'editor', actionId: 'undo' });

    expect(ran).toEqual(['pong', 'undo']);
    expect(events.map((event) => event.source)).toEqual(['programmatic', 'programmatic']);
  });

  it('notify reports a programmatic event without running the handler', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.activate(editor, (action) => ran.push(action));
    registry.setGlobalHandler(global, (action) => ran.push(action));

    registry.notify(editor, 'save');
    registry.notifyRef({ contextId: 'global', actionId: 'ping' });

    expect(ran).toEqual([]);
    expect(events).toEqual([
      { contextId: 'editor', actionId: 'save', source: 'programmatic' },
      { contextId: 'global', actionId: 'ping', source: 'programmatic' },
    ]);
  });

  it('unknown ids warn and do nothing', () => {
    const { registry, events, logger } = make();
    const ran: string[] = [];
    registry.setGlobalHandler(global, (action) => ran.push(action));

    registry.dispatchRef({ contextId: 'nope', actionId: 'ping' });
    registry.dispatchRef({ contextId: 'global', actionId: 'nope' });
    registry.notifyRef({ contextId: 'nope', actionId: 'ping' });

    expect(ran).toEqual([]);
    expect(events).toEqual([]);
    expect(logger.warn.mock.calls).toEqual([
      ['dispatch ignored: no context "nope"'],
      ['dispatch ignored: no action "nope" in context "global"'],
      ['notify ignored: no context "nope"'],
    ]);
  });

  it('typed dispatch throws for an unregistered context or unknown action', () => {
    const { registry } = make();
    expect(() => registry.dispatch(local, 'save')).toThrow(/not registered/);
    expect(() => registry.dispatch(editor, 'nope' as 'save')).toThrow(/has no action "nope"/);
    expect(() => registry.notify(editor, 'nope' as 'save')).toThrow(/has no action "nope"/);
  });
});

describe('shortcut dispatch', () => {
  it('a matched shortcut reports a shortcut event', () => {
    const { registry, events } = make();
    registry.activate(editor, () => {});
    registry.handleInput(metaKey('KeyZ'));
    expect(events).toEqual([{ contextId: 'editor', actionId: 'undo', source: 'shortcut' }]);
  });

  it('a held key repeats an action that allows key repeat', () => {
    const { registry } = make();
    const ran: string[] = [];
    registry.activate(editor, (action) => ran.push(action));
    expect(registry.handleInput(metaKey('KeyS'))).toBe('fired');
    expect(registry.handleInput(metaKey('KeyS', true))).toBe('fired');
    expect(ran).toEqual(['save', 'save']);
  });

  it('a held key fires an action that opts out of key repeat once, still consuming repeats', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.activate(editor, (action) => ran.push(action));
    expect(registry.handleInput(metaKey('KeyD'))).toBe('fired');
    expect(registry.handleInput(metaKey('KeyD', true))).toBe('fired');
    expect(registry.handleInput(metaKey('KeyD', true))).toBe('fired');
    expect(ran).toEqual(['deleteItem']);
    expect(events).toHaveLength(1);
  });

  it('a fresh press after a suppressed repeat fires again', () => {
    const { registry } = make();
    const ran: string[] = [];
    registry.activate(editor, (action) => ran.push(action));
    registry.handleInput(metaKey('KeyD'));
    registry.handleInput(metaKey('KeyD', true));
    registry.handleInput(metaKey('KeyD'));
    expect(ran).toEqual(['deleteItem', 'deleteItem']);
  });
});

describe('global contexts', () => {
  it('dispatchGlobal runs the global handler and reports a shortcut event', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.setGlobalHandler(global, (action) => ran.push(action));

    registry.dispatchGlobal({ contextId: 'global', actionId: 'ping' });

    expect(ran).toEqual(['ping']);
    expect(events).toEqual([{ contextId: 'global', actionId: 'ping', source: 'shortcut' }]);
  });

  it('dispatchGlobal ignores unknown ids', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    registry.setGlobalHandler(global, (action) => ran.push(action));
    registry.dispatchGlobal({ contextId: 'nope', actionId: 'ping' });
    registry.dispatchGlobal({ contextId: 'global', actionId: 'nope' });
    expect(ran).toEqual([]);
    expect(events).toEqual([]);
  });

  it('setGlobalHandler rejects a local context', () => {
    const { registry } = make();
    expect(() => registry.setGlobalHandler(editor, () => {})).toThrow(
      'Context "editor" is not global',
    );
  });

  it('removing a global handler stops it running', () => {
    const { registry, events } = make();
    const ran: string[] = [];
    const remove = registry.setGlobalHandler(global, (action) => ran.push(action));
    remove();
    registry.dispatchGlobal({ contextId: 'global', actionId: 'ping' });
    expect(ran).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('a replaced handler is not removed by the old handle', () => {
    const { registry } = make();
    const ran: string[] = [];
    const removeOld = registry.setGlobalHandler(global, () => ran.push('old'));
    registry.setGlobalHandler(global, () => ran.push('new'));
    removeOld();
    registry.dispatchGlobal({ contextId: 'global', actionId: 'ping' });
    expect(ran).toEqual(['new']);
  });

  it('globalBindings lists only global contexts', () => {
    const { registry } = make([global, local]);
    const bindings = registry.globalBindings();
    expect(bindings.map((binding) => binding.id)).toEqual([
      { contextId: 'global', actionId: 'ping', bindingIndex: 0 },
    ]);
    expect(bindings.map((binding) => formatShortcut(binding.shortcut))).toEqual([
      'ctrl+alt+meta+k',
    ]);
  });

  it('globalBindings reflects overrides and multiple bindings', () => {
    const { registry } = make([global]);
    registry.setShortcuts(global, 'ping', [
      parseShortcut('ctrl+alt+meta+j', 'mac'),
      parseShortcut('ctrl+alt+meta+l', 'mac'),
    ]);
    const bindings = registry.globalBindings();
    expect(bindings.map((binding) => binding.id.bindingIndex)).toEqual([0, 1]);
    expect(bindings.map((binding) => formatShortcut(binding.shortcut))).toEqual([
      'ctrl+alt+meta+j',
      'ctrl+alt+meta+l',
    ]);
  });

  it('a global context does not match local input', () => {
    const { registry } = make([global]);
    const ran: string[] = [];
    registry.setGlobalHandler(global, (action) => ran.push(action));
    const result = registry.handleInput({
      type: 'key',
      code: 'KeyK',
      modifiers: modifiers(['ctrl', 'alt', 'meta']),
    });
    expect(result).toBe('ignored');
    expect(ran).toEqual([]);
  });
});
