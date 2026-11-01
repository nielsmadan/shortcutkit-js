import { useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  conflictOccurrences,
  conflictSeverity,
  describeConflict,
  formatShortcut,
  type Conflict,
  type KeyBindingEntry,
  type MenuShortcut,
  type Shortcut,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import {
  ShortcutKitProvider,
  type LayoutStore,
  ShortcutRecorder,
  useIsRecording,
  useRegistry,
  useRegistrySnapshot,
  useShortcutContext,
} from '@shortcutkit/react';
import {
  bindingKeyString,
  type GlobalHotkeyStatus,
  type GlobalHotkeys,
  type GlobalHotkeysSnapshot,
} from '@shortcutkit/tauri';
import { editor, findContext } from './contexts';

export type WindowRole = 'main' | 'settings' | 'smoke-peer';

const ROLES: readonly WindowRole[] = ['main', 'settings', 'smoke-peer'];

export function parseRole(value: string | null): WindowRole {
  return ROLES.find((role) => role === value) ?? 'main';
}

export interface AppProps {
  readonly registry: ShortcutRegistry;
  readonly hotkeys: GlobalHotkeys;
  readonly layout: LayoutStore;
  readonly role: WindowRole;
  readonly menuShortcuts: readonly MenuShortcut[];
}

function describeStatus(status: GlobalHotkeyStatus | undefined): string {
  if (status === undefined) return '';
  switch (status.type) {
    case 'failed':
      return `failed: ${status.error}`;
    case 'unsupported':
      return `unsupported: ${status.reason}`;
    default:
      return status.type;
  }
}

async function openSettingsWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('settings');
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const created = new WebviewWindow('settings', {
    url: 'index.html?role=settings',
    title: 'ShortcutKit settings',
    width: 800,
    height: 600,
  });
  await new Promise<void>((resolve, reject) => {
    void created.once('tauri://created', () => resolve());
    void created.once('tauri://error', (event) => reject(new Error(String(event.payload))));
  });
}

export function App({ registry, hotkeys, layout, role, menuShortcuts }: AppProps): ReactElement {
  return (
    <ShortcutKitProvider registry={registry} layout={layout}>
      <header>
        <h1>ShortcutKit Tauri example</h1>
        <p>
          Window role: <span id="role">{role}</span>
        </p>
      </header>
      <main>
        <EditorSection />
        <GlobalSection hotkeys={hotkeys} />
        <RegistrySections hotkeys={hotkeys} menuShortcuts={menuShortcuts} />
      </main>
    </ShortcutKitProvider>
  );
}

function RegistrySections({
  hotkeys,
  menuShortcuts,
}: {
  readonly hotkeys: GlobalHotkeys;
  readonly menuShortcuts: readonly MenuShortcut[];
}): ReactElement {
  const registry = useRegistry();
  useRegistrySnapshot();
  const menuCollisions = registry.menuCollisions(menuShortcuts);
  return (
    <>
      <BindingsSection hotkeys={hotkeys} menuCollisions={menuCollisions} />
      <ConflictsSection menuCollisions={menuCollisions} />
    </>
  );
}

function EditorSection(): ReactElement {
  const [fired, setFired] = useState('');
  useShortcutContext(editor, (action) => setFired(editor.actions[action].displayName));
  return (
    <section id="editor-section" aria-label="Editor">
      <h2>Editor</h2>
      <p>
        Last action: <span id="last-action">{fired}</span>
      </p>
    </section>
  );
}

function GlobalSection({ hotkeys }: { readonly hotkeys: GlobalHotkeys }): ReactElement {
  const { isOwner, paused } = useSyncExternalStore(
    hotkeys.subscribe,
    hotkeys.getSnapshot,
    hotkeys.getSnapshot,
  );
  const opening = useRef(false);
  const openSettings = async (): Promise<void> => {
    if (opening.current) return;
    opening.current = true;
    try {
      await openSettingsWindow();
    } catch (error) {
      console.error('opening the settings window failed', error);
    } finally {
      opening.current = false;
    }
  };
  return (
    <section id="global-section" aria-label="Global hotkeys">
      <h2>Global hotkeys</h2>
      <p>
        Owner: <span id="owner">{isOwner ? 'this window' : 'another window'}</span>
      </p>
      <p>
        Paused: <span id="paused">{paused ? 'yes (a recorder is recording)' : 'no'}</span>
      </p>
      <button id="open-settings" type="button" onClick={() => void openSettings()}>
        Open settings window
      </button>
    </section>
  );
}

function ConflictList({
  id,
  title,
  conflicts,
}: {
  readonly id: string;
  readonly title: string;
  readonly conflicts: readonly Conflict[];
}): ReactElement {
  return (
    <>
      <h3>{title}</h3>
      <ul id={id}>
        {conflicts.length === 0 ? (
          <li>None</li>
        ) : (
          conflicts.map((conflict, index) => {
            const text = `${conflictSeverity(conflict)}: ${describeConflict(conflict)}`;
            return <li key={`${index}:${text}`}>{text}</li>;
          })
        )}
      </ul>
    </>
  );
}

function ConflictsSection({
  menuCollisions,
}: {
  readonly menuCollisions: readonly Conflict[];
}): ReactElement {
  const { conflicts } = useRegistrySnapshot();
  return (
    <section id="conflicts-section" aria-label="Conflicts">
      <h2>Conflicts</h2>
      <ConflictList
        id="duplicates"
        title="Duplicates"
        conflicts={conflicts.filter((conflict) => conflict.type === 'duplicate')}
      />
      <ConflictList
        id="system-collisions"
        title="System collisions"
        conflicts={conflicts.filter((conflict) => conflict.type === 'systemShared')}
      />
      <ConflictList id="menu-collisions" title="Menu collisions" conflicts={menuCollisions} />
    </section>
  );
}

function BindingsSection({
  hotkeys,
  menuCollisions,
}: {
  readonly hotkeys: GlobalHotkeys;
  readonly menuCollisions: readonly Conflict[];
}): ReactElement {
  const registry = useRegistry();
  const { keyBindings } = useRegistrySnapshot();
  const recording = useIsRecording();
  const global = useSyncExternalStore(hotkeys.subscribe, hotkeys.getSnapshot, hotkeys.getSnapshot);
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
            <th>Conflicts</th>
            <th>Global status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {keyBindings.groups.flatMap((group) =>
            group.entries.map((entry) => (
              <BindingRow
                key={entry.id}
                groupName={group.displayName}
                entry={entry}
                global={global}
                menuCollisions={menuCollisions}
              />
            )),
          )}
        </tbody>
      </table>
      <button id="reset-all" type="button" onClick={() => registry.resetAll()}>
        Reset all
      </button>
    </section>
  );
}

function BindingRow({
  groupName,
  entry,
  global,
  menuCollisions,
}: {
  readonly groupName: string;
  readonly entry: KeyBindingEntry;
  readonly global: GlobalHotkeysSnapshot;
  readonly menuCollisions: readonly Conflict[];
}): ReactElement | null {
  const registry = useRegistry();
  const context = findContext(entry.contextId);
  if (!context) return null;
  const { actionId } = entry;
  const conflicts = [
    ...entry.conflicts,
    ...menuCollisions.filter((conflict) =>
      conflictOccurrences(conflict).some(
        (occurrence) =>
          occurrence.contextId === entry.contextId && occurrence.actionId === actionId,
      ),
    ),
  ];
  const statuses = entry.shortcuts.map((_, bindingIndex) =>
    global.statuses.get(bindingKeyString({ contextId: context.id, actionId, bindingIndex })),
  );
  const onChange = (next: Shortcut | undefined) => {
    const rest = registry.shortcuts(context, actionId).slice(1);
    registry.setShortcuts(context, actionId, next === undefined ? rest : [next, ...rest]);
  };
  return (
    <tr id={`binding-${entry.contextId}-${actionId}`}>
      <td>{`${groupName}: ${entry.displayName}`}</td>
      <td>
        <ShortcutRecorder
          id={`recorder-${entry.contextId}-${actionId}`}
          aria-label={`${entry.displayName} shortcut`}
          scope={context.scope}
          value={entry.shortcuts[0]}
          onChange={onChange}
        />
      </td>
      <td>{entry.shortcuts.map(formatShortcut).join(', ')}</td>
      <td>{conflicts.map((c) => `${conflictSeverity(c)}: ${describeConflict(c)}`).join('; ')}</td>
      <td id={`global-status-${entry.contextId}-${actionId}`}>
        {statuses.map(describeStatus).filter(Boolean).join(', ')}
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
