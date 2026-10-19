import { describe, expect, it, vi } from 'vitest';
import { ShortcutRegistry } from '../src/registry';
import {
  type Conflict,
  type ContextScope,
  type Occurrence,
  analyzeConflicts,
  conflictOccurrences,
  conflictSeverity,
  defineContext,
  detectMenuCollisions,
  keyStep,
  memoryStore,
  modifiers,
  parseShortcut,
  shortcutOf,
  type RegistryOptions,
  type Shortcut,
} from '../src';

const parse = (text: string): Shortcut => parseShortcut(text, 'mac');

const occ = (contextId: string, actionId: string, shortcut: string | Shortcut): Occurrence => ({
  contextId,
  actionId,
  shortcut: typeof shortcut === 'string' ? parse(shortcut) : shortcut,
});

const keyShortcut = (code: string): Shortcut => shortcutOf(keyStep(code, modifiers(['meta'])));

const ofType = <T extends Conflict['type']>(conflicts: readonly Conflict[], type: T) =>
  conflicts.filter((c): c is Extract<Conflict, { type: T }> => c.type === type);

const quietLogger = () => ({
  warn: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
});

const registry = (options: Omit<RegistryOptions, 'platform'>) =>
  new ShortcutRegistry({
    platform: 'mac',
    store: memoryStore(),
    logger: quietLogger(),
    ...options,
  });

describe('analyzeConflicts: duplicates and prefixes', () => {
  it('reports same-trigger single-step duplicates within one context as an error', () => {
    const conflicts = analyzeConflicts({
      occurrences: [occ('editor', 'save', 'meta+s'), occ('editor', 'alsoSave', 'meta+s')],
    });
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(conflict?.type).toBe('duplicate');
    expect(conflict && conflictOccurrences(conflict).map((o) => o.actionId)).toEqual([
      'save',
      'alsoSave',
    ]);
    expect(conflict && conflictSeverity(conflict)).toBe('error');
  });

  it('reports same-trigger duplicates across contexts as a warning', () => {
    const conflicts = analyzeConflicts({
      occurrences: [occ('editor', 'save', 'meta+s'), occ('viewer', 'secondSave', 'meta+s')],
    });
    expect(conflicts.map((c) => [c.type, conflictSeverity(c)])).toEqual([['duplicate', 'warning']]);
  });

  it('suppresses cross-context duplicates between mutually exclusive contexts', () => {
    const conflicts = analyzeConflicts({
      occurrences: [occ('editor', 'save', 'meta+s'), occ('viewer', 'secondSave', 'meta+s')],
      mutuallyExclusiveContexts: [['editor', 'viewer']],
    });
    expect(conflicts).toEqual([]);
  });

  it('still reports a duplicate when one pair in the group can coactivate', () => {
    const conflicts = analyzeConflicts({
      occurrences: [
        occ('editor', 'save', 'meta+s'),
        occ('viewer', 'save', 'meta+s'),
        occ('panel', 'save', 'meta+s'),
      ],
      mutuallyExclusiveContexts: [['editor', 'viewer']],
    });
    expect(
      ofType(conflicts, 'duplicate').map((c) => c.occurrences.map((o) => o.contextId)),
    ).toEqual([['editor', 'viewer', 'panel']]);
  });

  it('does not treat a multi-step shortcut as a duplicate of a single-step one', () => {
    const conflicts = analyzeConflicts({
      occurrences: [occ('editor', 'save', 'meta+s'), occ('editor', 'saveAndKill', 'meta+k meta+s')],
    });
    expect(conflicts).toEqual([]);
  });

  it('reports an unreachable prefix within one context as an error', () => {
    const blocker = occ('editor', 'saveChord', 'meta+k');
    const blocked = occ('editor', 'saveLong', 'meta+k meta+s');
    const prefixes = ofType(
      analyzeConflicts({ occurrences: [blocker, blocked] }),
      'unreachablePrefix',
    );
    expect(prefixes).toEqual([{ type: 'unreachablePrefix', blocker, blocked }]);
    expect(prefixes.map(conflictSeverity)).toEqual(['error']);
    expect(prefixes.flatMap(conflictOccurrences)).toEqual([blocker, blocked]);
  });

  it('reports an unreachable prefix across contexts as a warning', () => {
    const prefixes = ofType(
      analyzeConflicts({
        occurrences: [
          occ('editor', 'saveChord', 'meta+k'),
          occ('viewer', 'saveLong', 'meta+k meta+s'),
        ],
      }),
      'unreachablePrefix',
    );
    expect(prefixes.map(conflictSeverity)).toEqual(['warning']);
  });

  it('suppresses an unreachable prefix between mutually exclusive contexts', () => {
    const conflicts = analyzeConflicts({
      occurrences: [
        occ('editor', 'saveChord', 'meta+k'),
        occ('viewer', 'saveLong', 'meta+k meta+s'),
      ],
      mutuallyExclusiveContexts: [['editor', 'viewer']],
    });
    expect(conflicts).toEqual([]);
  });
});

describe('analyzeConflicts: layout-exclusive keys', () => {
  it('flags the ISO section key as ISO-only', () => {
    const occurrence = occ('editor', 'toggle', keyShortcut('IntlBackslash'));
    const conflicts = analyzeConflicts({ occurrences: [occurrence] });
    expect(conflicts).toEqual([{ type: 'layoutExclusiveKey', occurrence, layout: 'iso' }]);
  });

  it.each([
    'IntlYen',
    'IntlRo',
    'NumpadComma',
    'KanaMode',
    'Lang1',
    'Lang2',
    'Convert',
    'NonConvert',
  ])('flags %s as JIS-only', (code) => {
    const conflicts = analyzeConflicts({ occurrences: [occ('editor', 'act', keyShortcut(code))] });
    expect(ofType(conflicts, 'layoutExclusiveKey').map((c) => c.layout)).toEqual(['jis']);
  });

  it('rates a layout-exclusive key as a warning', () => {
    const [conflict] = analyzeConflicts({
      occurrences: [occ('editor', 'toggle', keyShortcut('IntlBackslash'))],
    });
    expect(conflict && conflictSeverity(conflict)).toBe('warning');
  });

  it('produces no conflict for an ordinary ANSI key', () => {
    expect(analyzeConflicts({ occurrences: [occ('editor', 'save', 'meta+s')] })).toEqual([]);
  });

  it('flags a layout-exclusive key anywhere in a chord', () => {
    const chord = shortcutOf(keyStep('KeyK', modifiers(['meta'])), keyStep('IntlBackslash'));
    const conflicts = analyzeConflicts({ occurrences: [occ('editor', 'chord', chord)] });
    expect(conflicts.map((c) => [c.type, conflictSeverity(c)])).toEqual([
      ['layoutExclusiveKey', 'warning'],
    ]);
  });

  it('reports the occurrence the conflict came from', () => {
    const [conflict] = analyzeConflicts({
      occurrences: [occ('editor', 'toggle', keyShortcut('IntlBackslash'))],
    });
    expect(conflict && conflictOccurrences(conflict).map((o) => o.actionId)).toEqual(['toggle']);
  });
});

describe('analyzeConflicts: system shortcuts', () => {
  it('flags a single-step key shortcut matching a system shortcut as a warning', () => {
    const occurrence = occ('editor', 'save', 'meta+s');
    const conflicts = analyzeConflicts({
      occurrences: [occurrence],
      systemShortcuts: [parse('meta+s')],
    });
    expect(conflicts).toEqual([{ type: 'systemShared', occurrence }]);
    expect(conflicts.map(conflictSeverity)).toEqual(['warning']);
  });

  it('only flags key shortcuts, since system hotkeys are keyboard-only', () => {
    const conflicts = analyzeConflicts({
      occurrences: [occ('editor', 'save', 'meta+s'), occ('editor', 'click', 'meta+left-click')],
      systemShortcuts: [parse('meta+s'), parse('meta+left-click')],
    });
    expect(ofType(conflicts, 'systemShared').map((c) => c.occurrence.actionId)).toEqual(['save']);
  });
});

describe('analyzeConflicts: scopes', () => {
  const scopes = new Map<string, ContextScope>([
    ['editor', 'local'],
    ['launcher', 'global'],
  ]);

  it('reports a local binding shadowed by a global one as an error', () => {
    const local = occ('editor', 'save', 'meta+s');
    const global = occ('launcher', 'quickOpen', 'meta+s');
    const shadowed = ofType(
      analyzeConflicts({ occurrences: [local, global], contextScopes: scopes }),
      'shadowedByGlobal',
    );
    expect(shadowed).toEqual([{ type: 'shadowedByGlobal', local, global }]);
    expect(shadowed.map(conflictSeverity)).toEqual(['error']);
    expect(shadowed.flatMap(conflictOccurrences)).toEqual([local, global]);
  });

  it('reports a multi-step global binding as unsupported in scope', () => {
    const occurrence = occ('launcher', 'openPalette', 'meta+k meta+p');
    const conflicts = analyzeConflicts({ occurrences: [occurrence], contextScopes: scopes });
    expect(conflicts).toEqual([
      { type: 'unsupportedInScope', occurrence, reason: 'multiStepInGlobal' },
    ]);
    expect(conflicts.map(conflictSeverity)).toEqual(['error']);
  });

  it('reports a mouse global binding as unsupported in scope', () => {
    const occurrence = occ('launcher', 'click', 'meta+left-click');
    expect(analyzeConflicts({ occurrences: [occurrence], contextScopes: scopes })).toEqual([
      { type: 'unsupportedInScope', occurrence, reason: 'mouseInGlobal' },
    ]);
  });
});

describe('detectMenuCollisions', () => {
  it('reports a single-step binding colliding with a menu item, with its title', () => {
    const occurrence = occ('editor', 'save', 'meta+s');
    expect(
      detectMenuCollisions([occurrence], [{ shortcut: parse('meta+s'), title: 'File…' }]),
    ).toEqual([{ type: 'menuCollision', occurrence, menuItemTitle: 'File…' }]);
  });

  it('ignores a menu item with a different shortcut', () => {
    expect(
      detectMenuCollisions(
        [occ('editor', 'save', 'meta+s')],
        [{ shortcut: parse('meta+q'), title: 'Quit' }],
      ),
    ).toEqual([]);
  });

  it('ignores multi-step bindings', () => {
    const collisions = detectMenuCollisions(
      [occ('editor', 'save', 'meta+s'), occ('editor', 'long', 'meta+k meta+s')],
      [
        { shortcut: parse('meta+s'), title: 'Save' },
        { shortcut: parse('meta+k meta+s'), title: 'Long' },
      ],
    );
    expect(collisions.map((c) => conflictOccurrences(c)[0]?.actionId)).toEqual(['save']);
  });
});

describe('registry conflicts', () => {
  const sys = defineContext({
    id: 'editor',
    actions: {
      save: { displayName: 'Save', defaults: 'mod+s' },
      longSave: { displayName: 'Long Save', defaults: 'mod+k mod+s' },
      click: { displayName: 'Click', defaults: 'mod+left-click' },
    },
  });

  it('flags a binding matching a system shortcut', () => {
    const reg = registry({ contexts: [sys], systemShortcuts: () => [parse('meta+s')] });
    const shared = ofType(reg.getSnapshot().conflicts, 'systemShared');
    expect(shared.map((c) => c.occurrence.actionId)).toEqual(['save']);
    expect(shared.map(conflictSeverity)).toEqual(['warning']);
  });

  it('refreshes system conflicts on reload even when bindings are unchanged', async () => {
    let system: Shortcut[] = [];
    const reg = registry({ contexts: [sys], systemShortcuts: () => system });
    expect(ofType(reg.getSnapshot().conflicts, 'systemShared')).toEqual([]);
    system = [parse('meta+s')];
    expect(await reg.reload()).toEqual({ type: 'reloaded' });
    expect(
      ofType(reg.getSnapshot().conflicts, 'systemShared').map((c) => c.occurrence.actionId),
    ).toEqual(['save']);
  });

  it('reports menu collisions against the effective bindings', () => {
    const reg = registry({ contexts: [sys] });
    const collisions = reg.menuCollisions([
      { shortcut: parse('meta+s'), title: 'File…' },
      { shortcut: parse('meta+q'), title: 'Quit' },
    ]);
    expect(collisions).toEqual([
      {
        type: 'menuCollision',
        occurrence: occ('editor', 'save', 'meta+s'),
        menuItemTitle: 'File…',
      },
    ]);
  });

  it('reports a local binding shadowed by a global context', () => {
    const local = defineContext({
      id: 'editor',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const global = defineContext({
      id: 'launcher',
      scope: 'global',
      actions: { quickOpen: { displayName: 'Open', defaults: 'mod+s' } },
    });
    const reg = registry({ contexts: [local, global] });
    expect(ofType(reg.getSnapshot().conflicts, 'shadowedByGlobal')).toEqual([
      {
        type: 'shadowedByGlobal',
        local: occ('editor', 'save', 'meta+s'),
        global: occ('launcher', 'quickOpen', 'meta+s'),
      },
    ]);
  });

  it('reports a multi-step global default as unsupported in scope', () => {
    const chord = defineContext({
      id: 'g',
      scope: 'global',
      actions: { openPalette: { displayName: 'Palette', defaults: 'mod+k mod+p' } },
    });
    const reg = registry({ contexts: [chord] });
    expect(ofType(reg.getSnapshot().conflicts, 'unsupportedInScope').map((c) => c.reason)).toEqual([
      'multiStepInGlobal',
    ]);
  });

  it('creates one occurrence per binding of a multi-binding action', () => {
    const dup = defineContext({
      id: 'x',
      actions: {
        a: { displayName: 'A', defaults: ['mod+s', 'ctrl+s'] },
        b: { displayName: 'B', defaults: 'ctrl+s' },
      },
    });
    const reg = registry({ contexts: [dup] });
    expect(ofType(reg.getSnapshot().conflicts, 'duplicate')).toEqual([
      { type: 'duplicate', occurrences: [occ('x', 'a', 'ctrl+s'), occ('x', 'b', 'ctrl+s')] },
    ]);
  });
});

describe('default-level conflicts', () => {
  it('logs an error naming both actions of an error-severity conflict among defaults', () => {
    const buggy = defineContext({
      id: 'editor',
      actions: {
        save: { displayName: 'Save', defaults: 'mod+s' },
        alsoSave: { displayName: 'Also Save', defaults: 'mod+s' },
      },
    });
    const logger = quietLogger();
    new ShortcutRegistry({ contexts: [buggy], platform: 'mac', logger });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = logger.error.mock.calls[0]?.[0];
    expect(message).toContain('default-level');
    expect(message).toContain('editor.save');
    expect(message).toContain('editor.alsoSave');
  });

  it('does not log for warning-severity conflicts among defaults', () => {
    const editor = defineContext({
      id: 'editor',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const viewer = defineContext({
      id: 'viewer',
      actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
    });
    const logger = quietLogger();
    const reg = new ShortcutRegistry({ contexts: [editor, viewer], platform: 'mac', logger });
    expect(reg.getSnapshot().conflicts.map(conflictSeverity)).toEqual(['warning']);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
