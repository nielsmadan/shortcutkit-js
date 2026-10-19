import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  createRegistry,
  defineContext,
  formatShortcut,
  memoryStore,
  parseShortcut,
  type ShortcutContext,
} from '../src';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    quit: { displayName: 'Quit', defaults: 'mod+q' },
  },
});

const browser = defineContext({
  id: 'browser',
  actions: {
    newTab: { displayName: 'New Tab', defaults: 'mod+n' },
  },
});

const multi = defineContext({
  id: 'multi',
  actions: {
    save: { displayName: 'Save', defaults: ['mod+s', 'ctrl+s'] },
  },
});

const sc = (text: string) => parseShortcut(text, 'mac');

function silentLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

function texts<A extends string>(
  registry: ShortcutRegistry,
  context: ShortcutContext<A>,
  action: A,
): string[] {
  return registry.shortcuts(context, action).map(formatShortcut);
}

function make(contexts: readonly ShortcutContext[] = [editor]) {
  return new ShortcutRegistry({ contexts, platform: 'mac', logger: silentLogger() });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('context declarations', () => {
  it('defaults to local scope, included in settings, with a derived display name', () => {
    const context = defineContext({
      id: 'canvas.shared',
      actions: { noop: { displayName: 'Noop' } },
    });
    expect(context.scope).toBe('local');
    expect(context.includeInSettings).toBe(true);
    expect(context.displayName).toBe('Canvas / Shared');
  });

  it('opts into global scope and an explicit display name', () => {
    const context = defineContext({
      id: 'menu',
      scope: 'global',
      displayName: 'Menu Bar',
      includeInSettings: false,
      actions: { noop: { displayName: 'Noop' } },
    });
    expect(context.scope).toBe('global');
    expect(context.displayName).toBe('Menu Bar');
    expect(context.includeInSettings).toBe(false);
  });

  it('resolves an action definition with its display name, defaults and key repeat', () => {
    expect(editor.actions.save).toEqual({
      id: 'save',
      displayName: 'Save',
      description: undefined,
      defaults: ['mod+s'],
      allowsKeyRepeat: true,
    });
  });

  it('gives an action without a shortcut an empty default list', () => {
    const context = defineContext({ id: 'c', actions: { quit: { displayName: 'Quit' } } });
    expect(context.actions.quit.defaults).toEqual([]);
  });

  it('keeps several defaults for one action', () => {
    expect(multi.actions.save.defaults).toEqual(['mod+s', 'ctrl+s']);
  });

  it('uses the action key as its persistence id, in declaration order', () => {
    expect(editor.actionIds).toEqual(['save', 'quit']);
  });

  it('rejects a default that does not parse', () => {
    expect(() =>
      defineContext({ id: 'bad', actions: { x: { displayName: 'X', defaults: 'mod+nope' } } }),
    ).toThrow(/unknownKey/);
  });
});

describe('registry construction', () => {
  it('exposes its registered contexts', () => {
    const registry = make([editor, browser]);
    expect(registry.contexts.map((context) => context.id)).toEqual(['editor', 'browser']);
    expect(registry.contexts.map((context) => context.scope)).toEqual(['local', 'local']);
  });

  it('rejects duplicate context ids', () => {
    const twin = defineContext({ id: 'editor', actions: { x: { displayName: 'X' } } });
    expect(() => make([editor, twin])).toThrow(/Duplicate context ids: editor/);
  });

  it('rejects unknown ids in mutuallyExclusiveContexts', () => {
    expect(
      () =>
        new ShortcutRegistry({
          contexts: [editor],
          platform: 'mac',
          mutuallyExclusiveContexts: [['editor', 'ghost']],
        }),
    ).toThrow(/unknown contexts: ghost/);
  });

  it('logs default-level error conflicts', () => {
    const clash = defineContext({
      id: 'clash',
      actions: {
        a: { displayName: 'A', defaults: 'mod+s' },
        b: { displayName: 'B', defaults: 'mod+s' },
      },
    });
    const logger = silentLogger();
    new ShortcutRegistry({ contexts: [clash], platform: 'mac', logger });
    expect(logger.error).toHaveBeenCalledWith(
      'default-level conflicts: duplicate trigger across [clash.a / clash.b]',
    );
  });

  it('resolves mod per platform', () => {
    const registry = new ShortcutRegistry({ contexts: [editor], platform: 'windows' });
    expect(texts(registry, editor, 'save')).toEqual(['ctrl+s']);
  });
});

describe('lookup and overrides', () => {
  it('starts from the declared defaults with nothing customized', () => {
    const registry = make();
    expect(texts(registry, editor, 'save')).toEqual(['meta+s']);
    expect(registry.isCustomized(editor, 'save')).toBe(false);
  });

  it('returns an empty list for an action without defaults', () => {
    const context = defineContext({ id: 'c', actions: { quit: { displayName: 'Quit' } } });
    expect(make([context]).shortcuts(context, 'quit')).toEqual([]);
  });

  it('returns every default binding in order', () => {
    expect(texts(make([multi]), multi, 'save')).toEqual(['meta+s', 'ctrl+s']);
  });

  it('setShortcuts replaces the effective shortcuts and marks the action customized', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    expect(texts(registry, editor, 'save')).toEqual(['shift+meta+s']);
    expect(registry.isCustomized(editor, 'save')).toBe(true);
    expect(registry.rawState.overrides).toEqual({ editor: { save: ['shift+meta+s'] } });
  });

  it('an override list wins over several defaults', () => {
    const registry = make([multi]);
    registry.setShortcuts(multi, 'save', [sc('alt+s')]);
    expect(texts(registry, multi, 'save')).toEqual(['alt+s']);
  });

  it('an empty override unbinds the action', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', []);
    expect(registry.shortcuts(editor, 'save')).toEqual([]);
    expect(registry.isCustomized(editor, 'save')).toBe(true);
  });

  it('reset clears the override and restores the default', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    registry.reset(editor, 'save');
    expect(texts(registry, editor, 'save')).toEqual(['meta+s']);
    expect(registry.isCustomized(editor, 'save')).toBe(false);
  });

  it('reset clears one override; resetAll clears them all', () => {
    const registry = make([editor, browser]);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    registry.setShortcuts(editor, 'quit', [sc('mod+shift+q')]);
    registry.setShortcuts(browser, 'newTab', [sc('alt+n')]);

    registry.reset(editor, 'save');
    expect(registry.isCustomized(editor, 'save')).toBe(false);
    expect(registry.isCustomized(editor, 'quit')).toBe(true);

    registry.resetAll();
    expect(texts(registry, editor, 'quit')).toEqual(['meta+q']);
    expect(texts(registry, browser, 'newTab')).toEqual(['meta+n']);
    expect(registry.rawState.overrides).toEqual({});
  });

  it('resetContext restores one context and leaves the others customized', () => {
    const registry = make([multi, browser]);
    registry.setShortcuts(multi, 'save', [sc('alt+s')]);
    registry.setShortcuts(browser, 'newTab', [sc('alt+n')]);
    registry.resetContext(multi);
    expect(texts(registry, multi, 'save')).toEqual(['meta+s', 'ctrl+s']);
    expect(texts(registry, browser, 'newTab')).toEqual(['alt+n']);
  });

  it('removeShortcut removes one binding by index', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', [sc('alt+s'), sc('ctrl+s')]);
    registry.removeShortcut(editor, 'save', 0);
    expect(texts(registry, editor, 'save')).toEqual(['ctrl+s']);
  });

  it('removeShortcut of the last binding leaves the action unbound and customized', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    registry.removeShortcut(editor, 'save', 0);
    expect(texts(registry, editor, 'save')).toEqual([]);
    expect(registry.isCustomized(editor, 'save')).toBe(true);
  });

  it('removeShortcut on a default binding stores the remaining defaults as an override', () => {
    const registry = make();
    registry.removeShortcut(editor, 'save', 0);
    expect(registry.rawState.overrides).toEqual({ editor: { save: [] } });
  });

  it('removeShortcut out of range keeps the bindings', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    registry.removeShortcut(editor, 'save', 99);
    registry.removeShortcut(editor, 'save', -1);
    expect(texts(registry, editor, 'save')).toEqual(['alt+s']);
  });

  it('throws for a context that is not registered', () => {
    const registry = make();
    expect(() => registry.shortcuts(browser, 'newTab')).toThrow(
      'Context "browser" is not registered with this registry',
    );
  });

  it('throws for a look-alike context object with a registered id', () => {
    const registry = make();
    const lookalike = defineContext({
      id: 'editor',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    expect(() => registry.setShortcuts(lookalike, 'save', [])).toThrow(/not registered/);
  });

  it('throws for an unknown action', () => {
    const registry = make();
    expect(() => registry.setShortcuts(editor, 'nope' as 'save', [])).toThrow(
      'Context "editor" has no action "nope"',
    );
    expect(() => registry.reset(editor, 'nope' as 'save')).toThrow(/has no action/);
  });

  it('one context declaration can back two independent registries', () => {
    const first = make();
    const second = make();
    first.setShortcuts(editor, 'save', [sc('alt+s')]);
    expect(texts(first, editor, 'save')).toEqual(['alt+s']);
    expect(texts(second, editor, 'save')).toEqual(['meta+s']);
  });

  it('loaded overrides are visible once the registry is created', async () => {
    const store = memoryStore({ overrides: { editor: { save: ['shift+meta+s'] } } });
    const registry = await createRegistry({ contexts: [editor], platform: 'mac', store });
    expect(texts(registry, editor, 'save')).toEqual(['shift+meta+s']);
    expect(registry.isCustomized(editor, 'save')).toBe(true);
  });

  it('skips stored bindings that do not parse and warns once', async () => {
    const logger = silentLogger();
    const store = memoryStore({ overrides: { editor: { save: ['bogus+s', 'alt+s'] } } });
    const registry = await createRegistry({ contexts: [editor], platform: 'mac', store, logger });
    registry.setShortcuts(editor, 'quit', [sc('alt+q')]);
    expect(texts(registry, editor, 'save')).toEqual(['alt+s']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('snapshot notifications', () => {
  it('setShortcuts publishes one snapshot with the new bindings', () => {
    const registry = make();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    expect(listener).toHaveBeenCalledTimes(1);
    const entry = registry.getSnapshot().keyBindings.groups[0]?.entries[0];
    expect(entry?.shortcuts.map(formatShortcut)).toEqual(['shift+meta+s']);
    expect(entry?.isCustomized).toBe(true);
  });

  it('resetAll publishes one snapshot', () => {
    const registry = make();
    registry.setShortcuts(editor, 'save', [sc('mod+shift+s')]);
    registry.setShortcuts(editor, 'quit', [sc('mod+shift+q')]);
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.resetAll();

    expect(listener).toHaveBeenCalledTimes(1);
    const entries = registry.getSnapshot().keyBindings.groups[0]?.entries ?? [];
    expect(entries.map((entry) => entry.isCustomized)).toEqual([false, false]);
  });

  it('a mutation that changes nothing keeps the same snapshot', () => {
    const registry = make();
    const before = registry.getSnapshot();
    registry.reset(editor, 'save');
    expect(registry.getSnapshot()).toBe(before);
  });

  it('snapshot entries carry ids, display names and descriptions', () => {
    const described = defineContext({
      id: 'doc',
      displayName: 'Document',
      actions: { save: { displayName: 'Save', description: 'Write to disk', defaults: 'mod+s' } },
    });
    const group = make([described]).getSnapshot().keyBindings.groups[0];
    expect(group?.displayName).toBe('Document');
    expect(group?.entries[0]).toMatchObject({
      id: 'doc.save',
      contextId: 'doc',
      actionId: 'save',
      displayName: 'Save',
      description: 'Write to disk',
    });
  });

  it('an unsubscribed listener is no longer called', () => {
    const registry = make();
    const kept = vi.fn();
    const dropped = vi.fn();
    registry.subscribe(kept);
    registry.subscribe(dropped)();
    registry.setShortcuts(editor, 'save', [sc('alt+s')]);
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });
});

describe('hint preferences', () => {
  function hintsRegistry(store = memoryStore(), extra: { defaultHintsEnabled?: boolean } = {}) {
    return createRegistry({ contexts: [editor], platform: 'mac', store, ...extra });
  }

  it('hintsEnabled follows the app default when unset', async () => {
    expect((await hintsRegistry()).getSnapshot().hintsEnabled).toBe(true);
    expect(
      (await hintsRegistry(memoryStore(), { defaultHintsEnabled: false })).getSnapshot()
        .hintsEnabled,
    ).toBe(false);
  });

  it('setHintsEnabled persists an override that a new registry reads back', async () => {
    const store = memoryStore();
    const registry = await hintsRegistry(store);
    registry.setHintsEnabled(false);
    expect(registry.getSnapshot().hintsEnabled).toBe(false);
    await registry.flush();

    expect((await hintsRegistry(store)).getSnapshot().hintsEnabled).toBe(false);
  });

  it('setting hintsEnabled back to the default clears the stored override', async () => {
    const store = memoryStore();
    const registry = await hintsRegistry(store);
    registry.setHintsEnabled(false);
    registry.setHintsEnabled(true);
    await registry.flush();
    expect(store.current).toEqual({ overrides: {}, preferences: {} });
  });

  it('an off-by-default registry persists an on override', async () => {
    const store = memoryStore();
    const registry = await hintsRegistry(store, { defaultHintsEnabled: false });
    registry.setHintsEnabled(true);
    await registry.flush();
    expect(store.current).toEqual({ overrides: {}, preferences: { hintsEnabled: true } });

    const reloaded = await hintsRegistry(store, { defaultHintsEnabled: false });
    expect(reloaded.getSnapshot().hintsEnabled).toBe(true);
  });

  it('hintFrequency follows the app default when unset', async () => {
    expect((await hintsRegistry()).getSnapshot().hintFrequency).toEqual({
      type: 'oncePerSession',
    });
    const custom = await createRegistry({
      contexts: [editor],
      platform: 'mac',
      defaultHintFrequency: { type: 'timeout', seconds: 30 },
    });
    expect(custom.getSnapshot().hintFrequency).toEqual({ type: 'timeout', seconds: 30 });
  });

  it('setHintFrequency persists an override that a new registry reads back', async () => {
    const store = memoryStore();
    const registry = await hintsRegistry(store);
    registry.setHintFrequency({ type: 'always' });
    expect(registry.getSnapshot().hintFrequency).toEqual({ type: 'always' });
    await registry.flush();
    expect(store.current).toEqual({ overrides: {}, preferences: { hintFrequency: 'always' } });

    expect((await hintsRegistry(store)).getSnapshot().hintFrequency).toEqual({ type: 'always' });
  });

  it('setting hintFrequency back to the default clears the stored override', async () => {
    const store = memoryStore();
    const registry = await hintsRegistry(store);
    registry.setHintFrequency({ type: 'always' });
    registry.setHintFrequency({ type: 'oncePerSession' });
    await registry.flush();
    expect(store.current).toEqual({ overrides: {}, preferences: {} });
  });

  it('a timeout default persists a divergent override and clears it on a match', async () => {
    const store = memoryStore();
    const makeTimeout = () =>
      createRegistry({
        contexts: [editor],
        platform: 'mac',
        store,
        defaultHintFrequency: { type: 'timeout', seconds: 30 },
      });
    const registry = await makeTimeout();
    registry.setHintFrequency({ type: 'oncePerSession' });
    await registry.flush();
    expect(store.current).toEqual({
      overrides: {},
      preferences: { hintFrequency: 'once-per-session' },
    });
    expect((await makeTimeout()).getSnapshot().hintFrequency).toEqual({ type: 'oncePerSession' });

    registry.setHintFrequency({ type: 'timeout', seconds: 30 });
    await registry.flush();
    expect(store.current).toEqual({ overrides: {}, preferences: {} });
  });

  it('a stored timeout frequency is read back with its seconds', async () => {
    const store = memoryStore({ preferences: { hintFrequency: 'timeout:12' } });
    expect((await hintsRegistry(store)).getSnapshot().hintFrequency).toEqual({
      type: 'timeout',
      seconds: 12,
    });
  });
});
