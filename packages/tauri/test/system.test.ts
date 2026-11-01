// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { keyStep, shortcutOf, type Modifiers } from '@shortcutkit/core';
import { loadSystemShortcuts, watchSystemShortcuts, type TauriIpc } from '../guest-js';

const none: Modifiers = { ctrl: false, alt: false, shift: false, meta: false };

const wire = (code: string, mods: Partial<Modifiers>) => ({
  code,
  modifiers: { ...none, ...mods },
});

function fakeIpc(responses: (() => Promise<unknown>)[]) {
  const invoke = vi.fn(() => (responses.shift() ?? (() => Promise.resolve([])))());
  return { ipc: { invoke, listen: vi.fn() } as unknown as TauriIpc, invoke };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const expected = (code: string, mods: Partial<Modifiers>) =>
  shortcutOf(keyStep(code, { ...none, ...mods }));

describe('system shortcuts', () => {
  it('get returns the loaded shortcuts as single-step key shortcuts', async () => {
    const { ipc, invoke } = fakeIpc([
      async () => [wire('Digit3', { meta: true, shift: true }), wire('Space', { ctrl: true })],
    ]);
    const system = await loadSystemShortcuts({ ipc });
    expect(invoke).toHaveBeenCalledWith('plugin:shortcutkit|system_shortcuts');
    expect(system.get()).toEqual([
      expected('Digit3', { meta: true, shift: true }),
      expected('Space', { ctrl: true }),
    ]);
  });

  it('an unchanged focus refresh does not call refreshConflicts', async () => {
    const list = () => [wire('Digit3', { meta: true })];
    const { ipc } = fakeIpc([async () => list(), async () => list()]);
    const system = await loadSystemShortcuts({ ipc });
    const refreshConflicts = vi.fn();
    const target = new EventTarget();
    const stop = watchSystemShortcuts({ refreshConflicts }, system, { target });
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(refreshConflicts).not.toHaveBeenCalled();
    stop();
  });

  it('a changed focus refresh calls refreshConflicts once and updates get', async () => {
    const { ipc } = fakeIpc([
      async () => [wire('Digit3', { meta: true })],
      async () => [wire('Digit4', { meta: true })],
    ]);
    const system = await loadSystemShortcuts({ ipc });
    const refreshConflicts = vi.fn();
    const target = new EventTarget();
    const stop = watchSystemShortcuts({ refreshConflicts }, system, { target });
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(refreshConflicts).toHaveBeenCalledTimes(1);
    expect(system.get()).toEqual([expected('Digit4', { meta: true })]);
    stop();
  });

  it('a rejected refresh keeps the list and warns', async () => {
    const { ipc } = fakeIpc([
      async () => [wire('Digit3', { meta: true })],
      async () => Promise.reject(new Error('boom')),
    ]);
    const warn = vi.fn();
    const system = await loadSystemShortcuts({ ipc, logger: { warn } });
    expect(await system.refresh()).toBe(false);
    expect(system.get()).toEqual([expected('Digit3', { meta: true })]);
    expect(warn).toHaveBeenCalledWith('system shortcuts refresh failed: Error: boom');
  });

  it('a failed first load warns and gives an empty list', async () => {
    const { ipc } = fakeIpc([async () => Promise.reject(new Error('boom'))]);
    const warn = vi.fn();
    const system = await loadSystemShortcuts({ ipc, logger: { warn } });
    expect(system.get()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('system shortcuts lookup failed: Error: boom');
  });

  it('stop removes the focus listener', async () => {
    const { ipc, invoke } = fakeIpc([async () => []]);
    const system = await loadSystemShortcuts({ ipc });
    const target = new EventTarget();
    const removeEventListener = vi.spyOn(target, 'removeEventListener');
    const stop = watchSystemShortcuts({ refreshConflicts: vi.fn() }, system, { target });
    stop();
    expect(removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a refresh that resolves after stop does not call refreshConflicts', async () => {
    let release: (value: unknown) => void = () => {};
    const { ipc } = fakeIpc([
      async () => [wire('Digit3', { meta: true })],
      () => new Promise((resolve) => (release = resolve)),
    ]);
    const system = await loadSystemShortcuts({ ipc });
    const refreshConflicts = vi.fn();
    const target = new EventTarget();
    const stop = watchSystemShortcuts({ refreshConflicts }, system, { target });
    target.dispatchEvent(new Event('focus'));
    stop();
    release([wire('Digit4', { meta: true })]);
    await flush();
    expect(system.get()).toEqual([expected('Digit4', { meta: true })]);
    expect(refreshConflicts).not.toHaveBeenCalled();
  });
});
