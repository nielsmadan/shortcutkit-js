import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  SequenceMatcher,
  keyStep,
  modifiers,
  mouseStep,
  parseShortcut,
  stepFromInput,
  stepMatches,
  type MatchResult,
  type ModifierName,
  type ShortcutInput,
} from '../src';

const key = (
  code: string,
  mods: ModifierName[] = [],
  extra: { readonly repeat?: boolean; readonly editingText?: boolean } = {},
): ShortcutInput => ({ type: 'key', code, modifiers: modifiers(mods), ...extra });

const typing = (code: string, mods: ModifierName[] = []) => key(code, mods, { editingText: true });

const click = (button: number, mods: ModifierName[] = []): ShortcutInput => ({
  type: 'mouse',
  button,
  modifiers: modifiers(mods),
});

const matcherFor = (text: string, options: ConstructorParameters<typeof SequenceMatcher>[1] = {}) =>
  new SequenceMatcher(parseShortcut(text, 'mac'), options);

const results = (matcher: SequenceMatcher, inputs: ShortcutInput[]): MatchResult[] =>
  inputs.map((input) => matcher.handle(input));

const lastResult = (text: string, inputs: ShortcutInput[]): MatchResult | undefined =>
  results(matcherFor(text), inputs).at(-1);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stepMatches', () => {
  it('matches the same key and modifiers', () => {
    expect(
      stepMatches(keyStep('Tab', modifiers(['meta', 'shift'])), key('Tab', ['meta', 'shift'])),
    ).toBe(true);
  });

  it('rejects different modifiers', () => {
    expect(stepMatches(keyStep('Tab', modifiers(['meta'])), key('Tab', ['meta', 'shift']))).toBe(
      false,
    );
  });

  it('rejects a different key', () => {
    expect(stepMatches(keyStep('Tab', modifiers(['meta'])), key('Enter', ['meta']))).toBe(false);
  });

  it('matches a key with no modifiers', () => {
    expect(stepMatches(keyStep('Tab'), key('Tab'))).toBe(true);
  });

  it('matches mouse buttons by number and modifiers', () => {
    expect(stepMatches(mouseStep(2, modifiers(['ctrl'])), click(2, ['ctrl']))).toBe(true);
    expect(stepMatches(mouseStep(2, modifiers(['ctrl'])), click(2))).toBe(false);
    expect(stepMatches(mouseStep(2), click(0))).toBe(false);
  });

  it('never matches across input kinds', () => {
    expect(stepMatches(mouseStep(0), key('Tab'))).toBe(false);
    expect(stepMatches(keyStep('Tab'), click(0))).toBe(false);
  });

  it('turns an input back into a step', () => {
    expect(stepFromInput(key('KeyK', ['meta'], { repeat: true }))).toEqual(
      keyStep('KeyK', modifiers(['meta'])),
    );
    expect(stepFromInput(click(3, ['alt']))).toEqual(mouseStep(3, modifiers(['alt'])));
  });
});

describe('SequenceMatcher', () => {
  it('fires a single-step shortcut on its input', () => {
    expect(matcherFor('meta+s').handle(key('KeyS', ['meta']))).toBe('fired');
  });

  it('ignores a non-matching input', () => {
    expect(matcherFor('meta+s').handle(key('KeyA', ['meta']))).toBe('ignored');
  });

  it('fires a mouse shortcut on its button', () => {
    expect(matcherFor('shift+right-click').handle(click(2, ['shift']))).toBe('fired');
    expect(matcherFor('shift+right-click').handle(click(0, ['shift']))).toBe('ignored');
  });

  it('advances a multi-step shortcut and then fires', () => {
    const matcher = matcherFor('meta+k meta+c');
    expect(matcher.handle(key('KeyK', ['meta']))).toBe('advanced');
    expect(matcher.currentStep).toBe(1);
    expect(matcher.isTracking).toBe(true);
    expect(matcher.handle(key('KeyC', ['meta']))).toBe('fired');
    expect(matcher.currentStep).toBe(0);
    expect(matcher.isTracking).toBe(false);
  });

  it('completes a sequence that mixes keys and mouse buttons', () => {
    const matcher = matcherFor('meta+k left-click');
    expect(results(matcher, [key('KeyK', ['meta']), click(0)])).toEqual(['advanced', 'fired']);
  });

  it('fires again after completing', () => {
    const matcher = matcherFor('meta+k meta+c');
    const chord = [key('KeyK', ['meta']), key('KeyC', ['meta'])];
    expect(results(matcher, [...chord, ...chord])).toEqual([
      'advanced',
      'fired',
      'advanced',
      'fired',
    ]);
  });

  it('resets to the start on a mismatch mid-sequence', () => {
    const matcher = matcherFor('meta+k meta+c');
    expect(matcher.handle(key('KeyK', ['meta']))).toBe('advanced');
    expect(matcher.handle(key('KeyX', ['meta']))).toBe('ignored');
    expect(matcher.currentStep).toBe(0);
    expect(matcher.handle(key('KeyK', ['meta']))).toBe('advanced');
  });

  it('counts a repeated first step as a mismatch of the second', () => {
    const matcher = matcherFor('meta+k meta+c');
    expect(
      results(matcher, [key('KeyK', ['meta']), key('KeyK', ['meta']), key('KeyC', ['meta'])]),
    ).toEqual(['advanced', 'ignored', 'ignored']);
  });

  it('resets an unfinished sequence after the step timeout', () => {
    const matcher = matcherFor('meta+k meta+c', { stepTimeoutMs: 10 });
    expect(matcher.handle(key('KeyK', ['meta']))).toBe('advanced');
    vi.advanceTimersByTime(9);
    expect(matcher.isTracking).toBe(true);
    vi.advanceTimersByTime(1);
    expect(matcher.isTracking).toBe(false);
    expect(matcher.currentStep).toBe(0);
    expect(matcher.handle(key('KeyC', ['meta']))).toBe('ignored');
  });

  it('uses a one second step timeout by default', () => {
    expect(DEFAULT_STEP_TIMEOUT_MS).toBe(1000);
    const matcher = matcherFor('meta+k meta+c');
    matcher.handle(key('KeyK', ['meta']));
    vi.advanceTimersByTime(999);
    expect(matcher.isTracking).toBe(true);
    vi.advanceTimersByTime(1);
    expect(matcher.isTracking).toBe(false);
  });

  it('restarts the timeout on every advanced step', () => {
    const matcher = matcherFor('meta+a meta+b meta+c', { stepTimeoutMs: 100 });
    expect(matcher.handle(key('KeyA', ['meta']))).toBe('advanced');
    vi.advanceTimersByTime(80);
    expect(matcher.handle(key('KeyB', ['meta']))).toBe('advanced');
    vi.advanceTimersByTime(80);
    expect(matcher.handle(key('KeyC', ['meta']))).toBe('fired');
  });

  it('cancels the pending timeout when the sequence fires', () => {
    const tracking: boolean[] = [];
    const matcher = matcherFor('meta+k meta+c', {
      stepTimeoutMs: 10,
      onTrackingChange: (value) => tracking.push(value),
    });
    results(matcher, [key('KeyK', ['meta']), key('KeyC', ['meta'])]);
    expect(vi.getTimerCount()).toBe(0);
    expect(tracking).toEqual([true, false]);
  });

  it('consumes an intermediate Tab step', () => {
    const matcher = new SequenceMatcher(parseShortcut('tab meta+c', 'mac'));
    expect(matcher.handle(key('Tab'))).toBe('advanced');
    expect(matcher.handle(key('KeyC', ['meta']))).toBe('fired');
  });

  it('consumes an intermediate Escape step', () => {
    expect(matcherFor('escape meta+c').handle(key('Escape'))).toBe('advanced');
  });

  it('keeps an in-progress sequence across modifier keydowns', () => {
    const matcher = matcherFor('meta+k meta+c');
    expect(
      results(matcher, [
        key('MetaLeft', ['meta']),
        key('KeyK', ['meta']),
        key('MetaLeft', ['meta']),
        key('ShiftRight', ['meta', 'shift']),
        key('KeyC', ['meta']),
      ]),
    ).toEqual(['ignored', 'advanced', 'ignored', 'ignored', 'fired']);
  });

  it('reports tracking changes on advance and completion', () => {
    const tracking: boolean[] = [];
    const matcher = matcherFor('meta+k meta+c', {
      onTrackingChange: (value) => tracking.push(value),
    });
    matcher.handle(key('KeyK', ['meta']));
    expect(tracking).toEqual([true]);
    matcher.handle(key('KeyC', ['meta']));
    expect(tracking).toEqual([true, false]);
  });

  it('reports tracking once across several advanced steps', () => {
    const tracking: boolean[] = [];
    const matcher = matcherFor('meta+a meta+b meta+c', {
      onTrackingChange: (value) => tracking.push(value),
    });
    results(matcher, [key('KeyA', ['meta']), key('KeyB', ['meta'])]);
    expect(tracking).toEqual([true]);
  });

  it('ends tracking on a mid-sequence mismatch', () => {
    const tracking: boolean[] = [];
    const matcher = matcherFor('meta+k meta+c', {
      onTrackingChange: (value) => tracking.push(value),
    });
    results(matcher, [key('KeyK', ['meta']), key('KeyX', ['meta'])]);
    expect(tracking).toEqual([true, false]);
    expect(matcher.isTracking).toBe(false);
  });

  it('ends tracking when the step times out', () => {
    const tracking: boolean[] = [];
    const matcher = matcherFor('meta+k meta+c', {
      stepTimeoutMs: 10,
      onTrackingChange: (value) => tracking.push(value),
    });
    matcher.handle(key('KeyK', ['meta']));
    vi.advanceTimersByTime(10);
    expect(tracking).toEqual([true, false]);
  });

  it('never starts tracking for an unrelated key', () => {
    const onTrackingChange = vi.fn();
    const matcher = matcherFor('meta+k meta+c', { onTrackingChange });
    expect(matcher.handle(key('KeyA', ['meta']))).toBe('ignored');
    expect(matcher.isTracking).toBe(false);
    expect(onTrackingChange).not.toHaveBeenCalled();
  });

  it('clears in-progress state on reset', () => {
    const tracking: boolean[] = [];
    const matcher = matcherFor('meta+k meta+c', {
      onTrackingChange: (value) => tracking.push(value),
    });
    matcher.handle(key('KeyK', ['meta']));
    matcher.reset();
    expect(tracking).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
    expect(matcher.handle(key('KeyC', ['meta']))).toBe('ignored');
  });

  it('hands a key off from one sequence to another', () => {
    const a = matcherFor('meta+k meta+c');
    const b = matcherFor('meta+x meta+y');
    const inputs = [key('KeyK', ['meta']), key('KeyX', ['meta']), key('KeyY', ['meta'])];
    const both = inputs.map((input) => [a.handle(input), b.handle(input)]);
    expect(both).toEqual([
      ['advanced', 'ignored'],
      ['ignored', 'advanced'],
      ['ignored', 'fired'],
    ]);
    expect([a.isTracking, b.isTracking]).toEqual([false, false]);
  });
});

describe('text-focus gate', () => {
  it('yields a bare key to a focused text field', () => {
    expect(lastResult('k', [typing('KeyK')])).toBe('ignored');
  });

  it('yields a shift-only combination to a focused text field', () => {
    expect(lastResult('shift+k', [typing('KeyK', ['shift'])])).toBe('ignored');
  });

  it('yields an alt-only combination to a focused text field', () => {
    expect(lastResult('alt+k', [typing('KeyK', ['alt'])])).toBe('ignored');
  });

  it('yields bare navigation and editing keys to a focused text field', () => {
    expect(lastResult('tab', [typing('Tab')])).toBe('ignored');
    expect(lastResult('enter', [typing('Enter')])).toBe('ignored');
    expect(lastResult('space', [typing('Space')])).toBe('ignored');
    expect(lastResult('up', [typing('ArrowUp')])).toBe('ignored');
    expect(lastResult('backspace', [typing('Backspace')])).toBe('ignored');
  });

  it('fires a meta shortcut over a focused text field', () => {
    expect(lastResult('meta+k', [typing('KeyK', ['meta'])])).toBe('fired');
  });

  it('fires a ctrl shortcut over a focused text field', () => {
    expect(lastResult('ctrl+k', [typing('KeyK', ['ctrl'])])).toBe('fired');
  });

  it('fires escape over a focused text field', () => {
    expect(lastResult('escape', [typing('Escape')])).toBe('fired');
  });

  it("completes a chord's bare second step over a focused text field", () => {
    expect(lastResult('meta+k s', [typing('KeyK', ['meta']), typing('KeyS')])).toBe('fired');
  });

  it('fires a bare key when no text is being edited', () => {
    expect(lastResult('k', [key('KeyK')])).toBe('fired');
    expect(lastResult('k', [key('KeyK', [], { editingText: false })])).toBe('fired');
  });

  it('fires a bare function key over a focused text field', () => {
    expect(lastResult('f5', [typing('F5')])).toBe('fired');
    expect(lastResult('f20', [typing('F20')])).toBe('fired');
  });

  it('fires a shift+meta shortcut over a focused text field', () => {
    expect(lastResult('shift+meta+k', [typing('KeyK', ['shift', 'meta'])])).toBe('fired');
  });

  it('fires a mouse-button shortcut', () => {
    expect(lastResult('left-click', [click(0)])).toBe('fired');
  });

  it('never starts a sequence whose first step is bare while text has focus', () => {
    const matcher = matcherFor('k s');
    expect(matcher.handle(typing('KeyK'))).toBe('ignored');
    expect(matcher.currentStep).toBe(0);
    expect(matcher.isTracking).toBe(false);
    expect(matcher.handle(typing('KeyS'))).toBe('ignored');
  });

  it('fires a suppressed shortcut again once focus leaves the field', () => {
    const matcher = matcherFor('k');
    expect(matcher.handle(typing('KeyK'))).toBe('ignored');
    expect(matcher.handle(key('KeyK'))).toBe('fired');
    expect(matcher.isTracking).toBe(false);
  });
});
