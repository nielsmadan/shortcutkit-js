import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  RawStateError,
  type RawState,
  actionIds,
  contextIds,
  decodeRawState,
  describeRawState,
  encodeRawState,
  formatHintPolicy,
  getBindings,
  parseHintPolicy,
  removeContext,
  removeOverride,
  setBindings,
  setOverride,
} from '../src';

const state = (
  overrides: RawState['overrides'],
  preferences: RawState['preferences'] = {},
): RawState => ({
  overrides,
  preferences,
});

describe('raw state accessors', () => {
  it('reads an existing override and undefined for a missing action or context', () => {
    const s = state({ editor: { save: ['meta+s'] } });
    expect(getBindings(s, 'editor', 'save')).toEqual(['meta+s']);
    expect(getBindings(s, 'editor', 'nope')).toBeUndefined();
    expect(getBindings(s, 'missing', 'save')).toBeUndefined();
  });

  it('creates a nested entry when setting bindings', () => {
    expect(setBindings(EMPTY_STATE, 'editor', 'save', ['meta+s']).overrides).toEqual({
      editor: { save: ['meta+s'] },
    });
  });

  it('removes the action and prunes the empty context when setting undefined', () => {
    const s = state({ editor: { save: ['meta+s'] } });
    expect(setBindings(s, 'editor', 'save', undefined).overrides).toEqual({});
  });

  it('prunes when setting an empty list', () => {
    const s = state({ editor: { save: ['meta+s'] } });
    expect(setBindings(s, 'editor', 'save', []).overrides).toEqual({});
  });

  it('leaves sibling actions intact when one is cleared', () => {
    const s = state({ editor: { save: ['meta+s'], new: ['meta+n'] } });
    expect(setBindings(s, 'editor', 'save', undefined).overrides).toEqual({
      editor: { new: ['meta+n'] },
    });
  });

  it('keeps an empty list through setOverride, meaning unbound', () => {
    const s = setOverride(EMPTY_STATE, 'editor', 'save', []);
    expect(s.overrides).toEqual({ editor: { save: [] } });
    expect(getBindings(s, 'editor', 'save')).toEqual([]);
  });

  it('removes an override and prunes the context it emptied', () => {
    const s = state({ editor: { save: ['meta+s'] }, viewer: { zoom: ['meta+n'] } });
    expect(removeOverride(s, 'editor', 'save').overrides).toEqual({ viewer: { zoom: ['meta+n'] } });
  });

  it('returns the same state when removing an override that does not exist', () => {
    const s = state({ editor: { save: ['meta+s'] } });
    expect(removeOverride(s, 'editor', 'nope')).toBe(s);
    expect(removeOverride(s, 'missing', 'save')).toBe(s);
  });

  it('drops a whole context with removeContext', () => {
    const s = state({ editor: { save: ['meta+s'] }, viewer: { zoom: ['meta+n'] } });
    expect(removeContext(s, 'editor').overrides).toEqual({ viewer: { zoom: ['meta+n'] } });
  });

  it('enumerates context and action ids', () => {
    const s = state({
      editor: { save: ['meta+s'], new: ['meta+n'] },
      viewer: { zoom: ['meta+n'] },
    });
    expect(new Set(contextIds(s))).toEqual(new Set(['editor', 'viewer']));
    expect(new Set(actionIds(s, 'editor'))).toEqual(new Set(['save', 'new']));
    expect(actionIds(s, 'missing')).toEqual([]);
  });

  it('leaves the input state unchanged', () => {
    const s = state({ editor: { save: ['meta+s'], new: ['meta+n'] } }, { hintsEnabled: false });
    const before = JSON.parse(JSON.stringify(s)) as RawState;
    setBindings(s, 'editor', 'save', ['ctrl+s']);
    setOverride(s, 'viewer', 'zoom', []);
    removeOverride(s, 'editor', 'new');
    removeContext(s, 'editor');
    expect(s).toEqual(before);
  });

  it('keeps preferences across override changes', () => {
    const s = state({}, { hintsEnabled: false, hintFrequency: 'always' });
    expect(setBindings(s, 'editor', 'save', ['meta+s']).preferences).toEqual({
      hintsEnabled: false,
      hintFrequency: 'always',
    });
  });
});

describe('describeRawState', () => {
  it('lists contexts and actions sorted, followed by preferences', () => {
    const s = state(
      { viewer: { zoom: ['meta+equal'] }, editor: { save: ['meta+s', 'ctrl+s'], close: [] } },
      { hintsEnabled: false, hintFrequency: 'timeout:30' },
    );
    expect(describeRawState(s)).toBe(
      [
        '[editor]',
        '  close = ',
        '  save = meta+s, ctrl+s',
        '[viewer]',
        '  zoom = meta+equal',
        '[preferences]',
        '  hints-enabled = false',
        '  hint-frequency = timeout:30',
      ].join('\n'),
    );
  });

  it('describes an empty state', () => {
    expect(describeRawState(EMPTY_STATE)).toBe('(no overrides)');
  });
});

describe('hint policy persistence', () => {
  it('round-trips persisted strings', () => {
    expect(formatHintPolicy({ type: 'always' })).toBe('always');
    expect(formatHintPolicy({ type: 'oncePerSession' })).toBe('once-per-session');
    expect(formatHintPolicy({ type: 'timeout', seconds: 30 })).toBe('timeout:30');

    expect(parseHintPolicy('always')).toEqual({ type: 'always' });
    expect(parseHintPolicy('once-per-session')).toEqual({ type: 'oncePerSession' });
    expect(parseHintPolicy('timeout:30')).toEqual({ type: 'timeout', seconds: 30 });
    expect(parseHintPolicy('timeout:30.0')).toEqual({ type: 'timeout', seconds: 30 });
    expect(parseHintPolicy('timeout:0.1')).toEqual({ type: 'timeout', seconds: 0.1 });
  });

  it.each(['timeout', 'timeout:', 'timeout:abc', 'timeout:1:2', 'timeout:-1', 'nonsense', ''])(
    'rejects %j',
    (text) => {
      expect(parseHintPolicy(text)).toBeUndefined();
    },
  );
});

describe('decodeRawState and encodeRawState', () => {
  it('round-trips overrides and preferences through JSON', () => {
    const s = state(
      { editor: { save: ['meta+s'], close: [] } },
      { hintsEnabled: false, hintFrequency: 'timeout:30' },
    );
    expect(decodeRawState(JSON.parse(JSON.stringify(encodeRawState(s))))).toEqual(s);
  });

  it('keeps hintsEnabled when hintFrequency is malformed', () => {
    const decoded = decodeRawState({
      overrides: {},
      preferences: { hintsEnabled: true, hintFrequency: 'bogus' },
    });
    expect(decoded.preferences).toEqual({ hintsEnabled: true });
  });

  it('keeps overrides when preferences are malformed', () => {
    const decoded = decodeRawState({
      overrides: { editor: { save: ['meta+s'] } },
      preferences: 'bogus',
    });
    expect(decoded).toEqual(state({ editor: { save: ['meta+s'] } }));
  });

  it('treats a missing value as empty state', () => {
    expect(decodeRawState(undefined)).toEqual(EMPTY_STATE);
    expect(decodeRawState(null)).toEqual(EMPTY_STATE);
    expect(decodeRawState({})).toEqual(EMPTY_STATE);
  });

  it.each([
    ['a non-object state', 'bogus'],
    ['non-object overrides', { overrides: [] }],
    ['a non-object context', { overrides: { editor: 'meta+s' } }],
    ['a scalar binding', { overrides: { editor: { save: 'meta+s' } } }],
    ['a non-string binding', { overrides: { editor: { save: [1] } } }],
  ])('throws a RawStateError for %s', (_label, value) => {
    expect(() => decodeRawState(value)).toThrow(RawStateError);
  });

  it('encodes with sorted keys and omits default preferences', () => {
    const encoded = encodeRawState(
      state({ viewer: { zoom: ['meta+equal'] }, editor: { undo: [], save: ['meta+s'] } }),
    );
    expect(JSON.stringify(encoded)).toBe(
      '{"overrides":{"editor":{"save":["meta+s"],"undo":[]},"viewer":{"zoom":["meta+equal"]}}}',
    );
  });
});
