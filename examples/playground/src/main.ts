import {
  createRegistry,
  parseShortcut,
  ShortcutParseError,
  stepLabel,
  syncRegistry,
  usLayout,
  type KeyboardLayout,
  type Platform,
  type RawState,
  type ShortcutContext,
} from '@shortcutkit/core';
import {
  attachInput,
  detectPlatform,
  keyboardLayoutProvider,
  localStorageStore,
} from '@shortcutkit/dom';
import { app, contexts, editor, findContext, list } from './contexts';
import { appendLog, renderActive, renderBindings, renderList, type LogKind } from './view';

const STORE_KEY = 'shortcutkit.playground';
const PLATFORMS: readonly Platform[] = ['mac', 'windows', 'linux', 'other'];

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

function isPlatform(value: string | null): value is Platform {
  return PLATFORMS.some((p) => p === value);
}

const override = new URLSearchParams(location.search).get('platform');
const overridden = isPlatform(override) ? override : undefined;
const platform: Platform = overridden ?? detectPlatform();
byId('platform').textContent = `${platform} (${overridden ? 'override' : 'detected'})`;
const overrideSelect = byId<HTMLSelectElement>('platform-override');
overrideSelect.value = overridden ?? '';
overrideSelect.addEventListener('change', () => {
  const url = new URL(location.href);
  if (overrideSelect.value === '') url.searchParams.delete('platform');
  else url.searchParams.set('platform', overrideSelect.value);
  location.href = url.href;
});

const log = byId<HTMLOListElement>('log');
const write = (kind: LogKind, text: string) => appendLog(log, kind, text);
const debugToggle = byId<HTMLInputElement>('debug-toggle');
byId('clear-log').addEventListener('click', () => log.replaceChildren());

const store = localStorageStore({ key: STORE_KEY });
const storedState = byId('stored-state');
const refreshStored = () => {
  storedState.textContent = localStorage.getItem(STORE_KEY) ?? '(empty)';
};

const registry = await createRegistry({ contexts, platform, store });
syncRegistry(registry, store, {
  onResult: (result) => {
    write('sync', `sync ${result.type}`);
    refreshStored();
  },
});

const layout = keyboardLayoutProvider();
const layoutSource = byId('layout-source');

const bindingsBody = byId<HTMLTableElement>('bindings').tBodies[0];
if (!bindingsBody) throw new Error('missing table body');
const activeContexts = byId('active-contexts');
let renderedState: RawState | undefined;
let renderedLayout: KeyboardLayout | undefined;
const render = () => {
  const snapshot = registry.getSnapshot();
  const keyboard = layout.getSnapshot();
  if (registry.rawState !== renderedState || keyboard !== renderedLayout) {
    renderedState = registry.rawState;
    renderedLayout = keyboard;
    renderBindings(bindingsBody, snapshot, platform, keyboard);
  }
  renderActive(activeContexts, snapshot);
  layoutSource.textContent = keyboard === usLayout ? 'US fallback' : 'navigator.keyboard';
};
registry.subscribe(render);
layout.subscribe(render);

registry.onActionFired((event) =>
  write('fired', `fired ${event.contextId}.${event.actionId} (${event.source})`),
);
registry.onDebugEvent((event) => {
  if (!debugToggle.checked) return;
  const { outcome } = event;
  const target =
    outcome.type === 'noMatch' ? '' : ` [${outcome.action.contextId}.${outcome.action.actionId}]`;
  write(
    'debug',
    `debug ${stepLabel(event.pressed, { platform, layout: layout.getSnapshot() })} → ${outcome.type}${target}`,
  );
});
const saveStatus = byId('save-status');
registry.onSaveResult((result) => {
  write('save', `save ${result.type}`);
  saveStatus.textContent = result.type;
  refreshStored();
});

const palette = byId('palette');
const help = byId('help');
const navStatus = byId('nav-status');
const mouseStatus = byId('mouse-status');

registry.activate(app, (action) => {
  switch (action) {
    case 'commandPalette':
      palette.hidden = !palette.hidden;
      break;
    case 'showHelp':
      help.hidden = !help.hidden;
      break;
    case 'navigateBack':
      navStatus.textContent = 'Back';
      break;
    case 'navigateForward':
      navStatus.textContent = 'Forward';
      break;
    case 'middleClick':
      mouseStatus.textContent = 'Middle click';
      break;
    case 'inspect':
      mouseStatus.textContent = 'Inspect';
      break;
    case 'altClick':
      mouseStatus.textContent = 'Alt click';
      break;
  }
});

const listItems = byId('list-items');
const listSelection = byId('list-selection');
let labels = Array.from({ length: 10 }, (_, i) => i + 1);
let selected = 0;
const renderListState = () => {
  renderList(listItems, labels, selected);
  const label = labels[selected];
  listSelection.textContent = label === undefined ? '(none)' : `Item ${label}`;
};
const moveTo = (index: number) => {
  selected = Math.max(0, Math.min(labels.length - 1, index));
  renderListState();
};
renderListState();

const editorStatus = byId('editor-status');
const editorSection = byId('editor-section');
let saveCount = 0;
let preview = false;
const renderEditor = () => {
  editorStatus.textContent = `Saved ${saveCount} times; preview ${preview ? 'on' : 'off'}`;
};
renderEditor();

byId('click-target').addEventListener('click', () => {
  const count = byId('click-count');
  count.textContent = String(Number(count.textContent) + 1);
});

function scopeToFocus(
  section: HTMLElement,
  context: ShortcutContext,
  handler: (action: string) => void,
): void {
  let deactivate: (() => void) | undefined;
  section.addEventListener('focusin', () => {
    deactivate ??= registry.activate(context, handler);
  });
  section.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && section.contains(next)) return;
    deactivate?.();
    deactivate = undefined;
  });
}

scopeToFocus(byId('list-section'), list, (action) => {
  switch (action) {
    case 'goToTop':
      moveTo(0);
      break;
    case 'goToEnd':
      moveTo(labels.length - 1);
      break;
    case 'nextItem':
      moveTo(selected + 1);
      break;
    case 'previousItem':
      moveTo(selected - 1);
      break;
    case 'deleteItem':
      labels = labels.filter((_, i) => i !== selected);
      moveTo(selected);
      break;
  }
});

scopeToFocus(editorSection, editor, (action) => {
  switch (action) {
    case 'save':
      saveCount += 1;
      break;
    case 'togglePreview':
      preview = !preview;
      break;
    case 'leaveField':
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      editorSection.focus();
      break;
  }
  renderEditor();
});

attachInput(registry);

const rebindAction = byId<HTMLSelectElement>('rebind-action');
rebindAction.replaceChildren(
  ...contexts.flatMap((context) =>
    context.actionIds.map((actionId) => {
      const option = document.createElement('option');
      option.value = `${context.id}.${actionId}`;
      option.dataset['context'] = context.id;
      option.dataset['action'] = actionId;
      option.textContent = `${context.displayName}: ${context.actions[actionId]?.displayName ?? actionId}`;
      return option;
    }),
  ),
);

const rebindInput = byId<HTMLInputElement>('rebind-input');
const rebindError = byId('rebind-error');
byId<HTMLFormElement>('rebind-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const { context: contextId, action: actionId } = rebindAction.selectedOptions[0]?.dataset ?? {};
  const context = findContext(contextId);
  if (!context || actionId === undefined) return;
  const parts = rebindInput.value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  try {
    const shortcuts = parts.map((part) => parseShortcut(part, registry.platform));
    rebindError.textContent = '';
    registry.setShortcuts(context, actionId, shortcuts);
  } catch (error) {
    if (!(error instanceof ShortcutParseError)) throw error;
    rebindError.textContent = error.message;
  }
});

byId('bindings').addEventListener('click', (event) => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const { context: contextId, action: actionId } = event.target.dataset;
  const context = findContext(contextId);
  if (context && actionId !== undefined) registry.reset(context, actionId);
});
byId('reset-all').addEventListener('click', () => registry.resetAll());
byId('reload-store').addEventListener('click', async () => {
  const result = await registry.reload();
  write('reload', `reload ${result.type}`);
  refreshStored();
});

render();
refreshStored();
document.body.dataset['ready'] = 'true';
