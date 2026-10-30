import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createRegistry, syncRegistry, type Platform } from '@shortcutkit/core';
import { detectPlatform, keyboardLayoutProvider, localStorageStore } from '@shortcutkit/dom';
import { App, isPlatform } from './App';
import { contexts } from './contexts';
import { createLogStore } from './log';
import './style.css';

const STORE_KEY = 'shortcutkit.react-playground';
const override = new URLSearchParams(location.search).get('platform');
const overridden = isPlatform(override) ? override : undefined;
const platform: Platform = overridden ?? detectPlatform();

const store = localStorageStore({ key: STORE_KEY });
const log = createLogStore(() => localStorage.getItem(STORE_KEY) ?? '(empty)');
const registry = await createRegistry({ contexts, platform, store });
syncRegistry(registry, store, {
  onResult: (result) => {
    log.write('sync', `sync ${result.type}`);
    log.refreshStored();
  },
});
const layout = keyboardLayoutProvider();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App
      registry={registry}
      layout={layout}
      log={log}
      platformLabel={`${platform} (${overridden ? 'override' : 'detected'})`}
      override={overridden}
    />
  </StrictMode>,
);
document.body.dataset['ready'] = 'true';
