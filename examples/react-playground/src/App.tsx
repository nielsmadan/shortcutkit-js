import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import {
  conflictSeverity,
  describeConflict,
  formatShortcut,
  stepLabel,
  usLayout,
  type KeyBindingEntry,
  type Platform,
  type Shortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import {
  ShortcutKitProvider,
  ShortcutRecorder,
  useFocusShortcutContext,
  useIsRecording,
  useRegistry,
  useRegistrySnapshot,
  useShortcutContext,
  type LayoutStore,
} from '@shortcutkit/react';
import { app, editor, findContext, list } from './contexts';
import type { LogStore } from './log';

const PLATFORMS: readonly Platform[] = ['mac', 'windows', 'linux', 'other'];

export function isPlatform(value: string | null): value is Platform {
  return PLATFORMS.some((p) => p === value);
}

export interface AppProps {
  readonly registry: ShortcutRegistry;
  readonly layout: LayoutStore;
  readonly log: LogStore;
  readonly platformLabel: string;
  readonly override: Platform | undefined;
}

export function App({ registry, layout, log, platformLabel, override }: AppProps): ReactElement {
  return (
    <ShortcutKitProvider registry={registry} layout={layout}>
      <Playground layout={layout} log={log} platformLabel={platformLabel} override={override} />
    </ShortcutKitProvider>
  );
}

interface PlaygroundProps {
  readonly layout: LayoutStore;
  readonly log: LogStore;
  readonly platformLabel: string;
  readonly override: Platform | undefined;
}

function Playground({ layout, log, platformLabel, override }: PlaygroundProps): ReactElement {
  const registry = useRegistry();
  const [debug, setDebug] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [navStatus, setNavStatus] = useState('');
  const [mouseStatus, setMouseStatus] = useState('');
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    const unsubscribers = [
      registry.onActionFired((event) =>
        log.write('fired', `fired ${event.contextId}.${event.actionId} (${event.source})`),
      ),
      registry.onSaveResult((result) => {
        log.write('save', `save ${result.type}`);
        setSaveStatus(result.type);
        log.refreshStored();
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [registry, log]);

  useEffect(() => {
    if (!debug) return undefined;
    return registry.onDebugEvent((event) => {
      const { outcome } = event;
      const target =
        outcome.type === 'noMatch' || outcome.type === 'suspended'
          ? ''
          : ` [${outcome.action.contextId}.${outcome.action.actionId}]`;
      const pressed = stepLabel(event.pressed, {
        platform: registry.platform,
        layout: layout.getSnapshot(),
      });
      log.write('debug', `debug ${pressed} → ${outcome.type}${target}`);
    });
  }, [registry, layout, log, debug]);

  useShortcutContext(app, (action) => {
    switch (action) {
      case 'commandPalette':
        setPaletteOpen((open) => !open);
        break;
      case 'showHelp':
        setHelpOpen((open) => !open);
        break;
      case 'navigateBack':
        setNavStatus('Back');
        break;
      case 'navigateForward':
        setNavStatus('Forward');
        break;
      case 'middleClick':
        setMouseStatus('Middle click');
        break;
      case 'inspect':
        setMouseStatus('Inspect');
        break;
      case 'altClick':
        setMouseStatus('Alt click');
        break;
    }
  });

  return (
    <>
      <header>
        <h1>ShortcutKit React playground</h1>
        <Status layout={layout} platformLabel={platformLabel} override={override} />
      </header>
      <main>
        <ListSection />
        <EditorSection />
        <MouseSection navStatus={navStatus} mouseStatus={mouseStatus} />
        <BindingsSection log={log} />
        <LogSection log={log} debug={debug} onDebugChange={setDebug} />
        <PersistenceSection log={log} saveStatus={saveStatus} />
      </main>
      <div
        id="palette"
        className="overlay"
        role="dialog"
        aria-label="Command palette"
        hidden={!paletteOpen}
      >
        Command palette (Mod+K to close)
      </div>
      <div id="help" className="overlay" role="dialog" aria-label="Help" hidden={!helpOpen}>
        Help (? to close)
      </div>
    </>
  );
}

function Status({
  layout,
  platformLabel,
  override,
}: Pick<PlaygroundProps, 'layout' | 'platformLabel' | 'override'>): ReactElement {
  const snapshot = useRegistrySnapshot();
  const keyboard = useSyncExternalStore(layout.subscribe, layout.getSnapshot);
  const onOverride = (value: string) => {
    const url = new URL(location.href);
    if (value === '') url.searchParams.delete('platform');
    else url.searchParams.set('platform', value);
    location.href = url.href;
  };
  return (
    <dl aria-label="Status">
      <dt>Platform</dt>
      <dd id="platform">{platformLabel}</dd>
      <dt>Override</dt>
      <dd>
        <select
          id="platform-override"
          aria-label="Platform override"
          value={override ?? ''}
          onChange={(event) => onOverride(event.target.value)}
        >
          <option value="">(detect)</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </dd>
      <dt>Layout</dt>
      <dd id="layout-source">{keyboard === usLayout ? 'US fallback' : 'navigator.keyboard'}</dd>
      <dt>Active</dt>
      <dd id="active-contexts">{snapshot.activations.map((a) => a.displayName).join(' > ')}</dd>
    </dl>
  );
}

function ListSection(): ReactElement {
  const [{ labels, selected }, setState] = useState({
    labels: Array.from({ length: 10 }, (_, i) => i + 1),
    selected: 0,
  });
  const moveTo = (index: number) =>
    setState((state) => ({
      ...state,
      selected: Math.max(0, Math.min(state.labels.length - 1, index)),
    }));
  const focusProps = useFocusShortcutContext(list, (action) => {
    switch (action) {
      case 'goToTop':
        moveTo(0);
        break;
      case 'goToEnd':
        setState((state) => ({ ...state, selected: state.labels.length - 1 }));
        break;
      case 'nextItem':
        setState((state) => ({
          ...state,
          selected: Math.min(state.labels.length - 1, state.selected + 1),
        }));
        break;
      case 'previousItem':
        setState((state) => ({ ...state, selected: Math.max(0, state.selected - 1) }));
        break;
      case 'deleteItem':
        setState((state) => {
          const remaining = state.labels.filter((_, i) => i !== state.selected);
          return {
            labels: remaining,
            selected: Math.max(0, Math.min(remaining.length - 1, state.selected)),
          };
        });
        break;
    }
  });
  const label = labels[selected];
  return (
    <section id="list-section" tabIndex={0} aria-label="List context" {...focusProps}>
      <h2>List (g g, g e, j, k, Mod+Backspace)</h2>
      <ul id="list-items" aria-label="List items">
        {labels.map((item, index) => (
          <li key={item} data-index={index} aria-selected={index === selected ? 'true' : undefined}>
            Item {item}
          </li>
        ))}
      </ul>
      <p>
        Selection:{' '}
        <span id="list-selection">{label === undefined ? '(none)' : `Item ${label}`}</span>
      </p>
    </section>
  );
}

function EditorSection(): ReactElement {
  const [saveCount, setSaveCount] = useState(0);
  const [preview, setPreview] = useState(false);
  const section = useRef<HTMLElement>(null);
  const focusProps = useFocusShortcutContext(editor, (action) => {
    switch (action) {
      case 'save':
        setSaveCount((count) => count + 1);
        break;
      case 'togglePreview':
        setPreview((on) => !on);
        break;
      case 'leaveField':
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        section.current?.focus();
        break;
    }
  });
  return (
    <section
      id="editor-section"
      ref={section}
      tabIndex={0}
      aria-label="Editor context"
      {...focusProps}
    >
      <h2>Editor (Mod+S, p, Escape)</h2>
      <input id="editor-title" type="text" aria-label="Editor title" placeholder="Title" />
      <div
        id="editor-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Editor body"
        aria-multiline="true"
      ></div>
      <p id="editor-status" aria-live="polite">
        Saved {saveCount} times; preview {preview ? 'on' : 'off'}
      </p>
    </section>
  );
}

function MouseSection({
  navStatus,
  mouseStatus,
}: {
  readonly navStatus: string;
  readonly mouseStatus: string;
}): ReactElement {
  const [clicks, setClicks] = useState(0);
  return (
    <section id="mouse-section" aria-label="Mouse">
      <h2>Mouse</h2>
      <div
        id="click-target"
        tabIndex={0}
        aria-label="Click target"
        onClick={() => setClicks((count) => count + 1)}
      >
        Click here
      </div>
      <p>
        Clicks reaching the target: <span id="click-count">{clicks}</span>
      </p>
      <p>
        Navigation: <span id="nav-status">{navStatus}</span>
      </p>
      <p>
        Mouse action: <span id="mouse-status">{mouseStatus}</span>
      </p>
    </section>
  );
}

function BindingsSection({ log }: { readonly log: LogStore }): ReactElement {
  const registry = useRegistry();
  const { keyBindings } = useRegistrySnapshot();
  const recording = useIsRecording();
  return (
    <section id="bindings-section" aria-label="Bindings">
      <h2>
        Bindings{' '}
        <span id="recording-indicator" role="status">
          {recording ? 'Recording…' : ''}
        </span>
      </h2>
      <table id="bindings" aria-label="Bindings table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Shortcut</th>
            <th>Grammar</th>
            <th>Customized</th>
            <th>Conflicts</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {keyBindings.groups.flatMap((group) =>
            group.entries.map((entry) => (
              <BindingRow key={entry.id} groupName={group.displayName} entry={entry} />
            )),
          )}
        </tbody>
      </table>
      <button id="reset-all" type="button" onClick={() => registry.resetAll()}>
        Reset all
      </button>
      <button
        id="reload-store"
        type="button"
        onClick={async () => {
          const result = await registry.reload();
          log.write('reload', `reload ${result.type}`);
          log.refreshStored();
        }}
      >
        Reload from store
      </button>
    </section>
  );
}

function BindingRow({
  groupName,
  entry,
}: {
  readonly groupName: string;
  readonly entry: KeyBindingEntry;
}): ReactElement | null {
  const registry = useRegistry();
  const context = findContext(entry.contextId);
  if (!context) return null;
  const { actionId } = entry;
  const onChange = (next: Shortcut | undefined) => {
    const rest = registry.shortcuts(context, actionId).slice(1);
    registry.setShortcuts(context, actionId, next === undefined ? rest : [next, ...rest]);
  };
  return (
    <tr id={`binding-${entry.contextId}-${actionId}`}>
      <td className="action">{`${groupName}: ${entry.displayName}`}</td>
      <td className="label">
        <ShortcutRecorder
          id={`recorder-${entry.contextId}-${actionId}`}
          aria-label={`${entry.displayName} shortcut`}
          scope={context.scope}
          value={entry.shortcuts[0]}
          onChange={onChange}
        />
      </td>
      <td className="grammar">{entry.shortcuts.map(formatShortcut).join(', ')}</td>
      <td className="customized">{entry.isCustomized ? 'customized' : ''}</td>
      <td className="conflicts">
        {entry.conflicts.map((c) => `${conflictSeverity(c)}: ${describeConflict(c)}`).join('; ')}
      </td>
      <td>
        {entry.isCustomized ? (
          <button
            id={`reset-${entry.contextId}-${actionId}`}
            type="button"
            onClick={() => registry.reset(context, actionId)}
          >
            Reset
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function LogSection({
  log,
  debug,
  onDebugChange,
}: {
  readonly log: LogStore;
  readonly debug: boolean;
  readonly onDebugChange: (debug: boolean) => void;
}): ReactElement {
  const { entries } = useSyncExternalStore(log.subscribe, log.getSnapshot);
  return (
    <section id="log-section" aria-label="Log">
      <h2>Log</h2>
      <label>
        <input
          id="debug-toggle"
          type="checkbox"
          checked={debug}
          onChange={(event) => onDebugChange(event.target.checked)}
        />{' '}
        Debug events
      </label>
      <button id="clear-log" type="button" onClick={() => log.clear()}>
        Clear
      </button>
      <ol id="log" aria-label="Event log">
        {entries.map((entry) => (
          <li key={entry.id} data-kind={entry.kind}>
            {entry.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

function PersistenceSection({
  log,
  saveStatus,
}: {
  readonly log: LogStore;
  readonly saveStatus: string;
}): ReactElement {
  const stored = useSyncExternalStore(log.subscribe, () => log.getSnapshot().stored);
  return (
    <section id="persistence-section" aria-label="Persistence">
      <h2>Persistence</h2>
      <p>
        Save status: <span id="save-status">{saveStatus}</span>
      </p>
      <pre id="stored-state" aria-label="Stored state">
        {stored}
      </pre>
    </section>
  );
}
