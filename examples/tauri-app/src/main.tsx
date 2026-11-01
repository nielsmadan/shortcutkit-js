import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createRegistry, syncRegistry } from '@shortcutkit/core';
import { detectPlatform, keyboardLayoutProvider } from '@shortcutkit/dom';
import {
  attachGlobalHotkeys,
  loadSystemShortcuts,
  tauriLayoutMap,
  tauriStore,
  watchSystemShortcuts,
} from '@shortcutkit/tauri';
import { App, parseRole } from './App';
import { app, contexts } from './contexts';
import { buildAppMenu, staticMenuShortcuts } from './menu';
import { runSmoke, runSmokePeer } from './smoke';

async function showMainWindow(): Promise<void> {
  const target = (await WebviewWindow.getByLabel('main')) ?? getCurrentWebviewWindow();
  await target.show();
  await target.setFocus();
}

const role = parseRole(new URLSearchParams(location.search).get('role'));
const store = tauriStore();
const systemShortcuts = await loadSystemShortcuts();
const registry = await createRegistry({
  contexts,
  platform: detectPlatform(),
  store,
  systemShortcuts: systemShortcuts.get,
});
watchSystemShortcuts(registry, systemShortcuts);
syncRegistry(registry, store);
registry.setGlobalHandler(app, (action) => {
  if (action === 'showWindow') void showMainWindow();
});
const hotkeys = attachGlobalHotkeys(registry, { systemShortcuts });
const layout = keyboardLayoutProvider({ load: tauriLayoutMap });
let menuError: unknown;
const menu =
  role === 'main'
    ? await buildAppMenu(registry).catch((error: unknown) => {
        menuError = error ?? new Error('unknown error');
        console.error('building the app menu failed', error);
        return undefined;
      })
    : undefined;

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App
      registry={registry}
      hotkeys={hotkeys}
      layout={layout}
      role={role}
      menuShortcuts={staticMenuShortcuts(registry.platform)}
    />
  </StrictMode>,
);

if (role === 'smoke-peer') void runSmokePeer(registry, hotkeys);
else if (role === 'main' && import.meta.env['SHORTCUTKIT_EXAMPLE_SMOKE'] === '1') {
  void runSmoke({
    registry,
    hotkeys,
    systemShortcuts,
    menuBindings: menu?.bindings ?? [],
    menuError,
  });
}
