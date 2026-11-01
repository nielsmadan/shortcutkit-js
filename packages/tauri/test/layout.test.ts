// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyboardLayoutProvider } from '@shortcutkit/dom';
import { tauriLayoutMap, type TauriIpc } from '../guest-js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeIpc(result: () => Promise<unknown>) {
  const invoke = vi.fn(result);
  const ipc = { invoke, listen: vi.fn() } as unknown as TauriIpc;
  return { ipc, invoke };
}

const withoutKeyboard = () => vi.stubGlobal('navigator', {});

describe('tauriLayoutMap', () => {
  it('prefers the browser layout map when navigator.keyboard has one', async () => {
    vi.stubGlobal('navigator', { keyboard: { getLayoutMap: async () => [['KeyA', 'q']] } });
    const { ipc, invoke } = fakeIpc(async () => ({ KeyA: 'a' }));
    const map = await tauriLayoutMap({ ipc });
    expect([...(map ?? [])]).toEqual([['KeyA', 'q']]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls through to the plugin when the browser layout map rejects', async () => {
    vi.stubGlobal('navigator', {
      keyboard: { getLayoutMap: async () => Promise.reject(new Error('denied')) },
    });
    const { ipc } = fakeIpc(async () => ({ KeyA: 'a' }));
    const map = await tauriLayoutMap({ ipc });
    expect([...(map ?? [])]).toEqual([['KeyA', 'a']]);
  });

  it('rejects with the browser error when it rejects and the plugin has no layout', async () => {
    vi.stubGlobal('navigator', {
      keyboard: { getLayoutMap: async () => Promise.reject(new Error('denied')) },
    });
    const { ipc } = fakeIpc(async () => null);
    await expect(tauriLayoutMap({ ipc })).rejects.toThrow('denied');
  });

  it('uses the plugin map when navigator.keyboard is absent', async () => {
    withoutKeyboard();
    const { ipc, invoke } = fakeIpc(async () => ({ KeyA: 'a', KeyZ: 'y' }));
    const map = await tauriLayoutMap({ ipc });
    expect(map).toBeInstanceOf(Map);
    expect([...(map ?? [])]).toEqual([
      ['KeyA', 'a'],
      ['KeyZ', 'y'],
    ]);
    expect(invoke).toHaveBeenCalledWith('plugin:shortcutkit|keyboard_layout');
  });

  it('gives undefined when the plugin has no layout', async () => {
    withoutKeyboard();
    const { ipc } = fakeIpc(async () => null);
    expect(await tauriLayoutMap({ ipc })).toBeUndefined();
  });

  it('rejects when the plugin call rejects', async () => {
    withoutKeyboard();
    const { ipc } = fakeIpc(async () => Promise.reject(new Error('boom')));
    await expect(tauriLayoutMap({ ipc })).rejects.toThrow('boom');
  });

  it('lets keyboardLayoutProvider warn once and keep the last good map across failed lookups', async () => {
    withoutKeyboard();
    let result: () => Promise<unknown> = async () => ({ KeyQ: 'a' });
    const { ipc } = fakeIpc(() => result());
    const warn = vi.fn();
    const layout = keyboardLayoutProvider({
      load: () => tauriLayoutMap({ ipc }),
      logger: { warn },
    });
    await layout.refresh();
    result = async () => Promise.reject(new Error('boom'));
    await layout.refresh();
    await layout.refresh();
    expect(layout.getSnapshot()('KeyQ')).toBe('a');
    expect(warn.mock.calls).toEqual([['keyboard layout lookup failed: Error: boom']]);
  });
});
