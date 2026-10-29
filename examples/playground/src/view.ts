import {
  conflictSeverity,
  describeConflict,
  formatShortcut,
  shortcutLabel,
  type KeyboardLayout,
  type Platform,
  type RegistrySnapshot,
} from '@shortcutkit/core';

const LOG_LIMIT = 200;

export type LogKind = 'fired' | 'debug' | 'sync' | 'save' | 'reload';

function cell(row: HTMLTableRowElement, className: string, text: string): void {
  const td = row.insertCell();
  td.className = className;
  td.textContent = text;
}

export function renderBindings(
  body: HTMLTableSectionElement,
  snapshot: RegistrySnapshot,
  platform: Platform,
  layout: KeyboardLayout,
): void {
  const rows = snapshot.keyBindings.groups.flatMap((group) =>
    group.entries.map((entry) => {
      const row = document.createElement('tr');
      row.id = `binding-${entry.contextId}-${entry.actionId}`;
      cell(row, 'action', `${group.displayName}: ${entry.displayName}`);
      cell(
        row,
        'label',
        entry.shortcuts.map((s) => shortcutLabel(s, { platform, layout })).join(', '),
      );
      cell(row, 'grammar', entry.shortcuts.map(formatShortcut).join(', '));
      cell(row, 'customized', entry.isCustomized ? 'customized' : '');
      cell(
        row,
        'conflicts',
        entry.conflicts.map((c) => `${conflictSeverity(c)}: ${describeConflict(c)}`).join('; '),
      );
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.id = `reset-${entry.contextId}-${entry.actionId}`;
      reset.dataset['context'] = entry.contextId;
      reset.dataset['action'] = entry.actionId;
      reset.textContent = 'Reset';
      row.insertCell().append(reset);
      return row;
    }),
  );
  body.replaceChildren(...rows);
}

export function renderActive(element: HTMLElement, snapshot: RegistrySnapshot): void {
  element.textContent = snapshot.activations.map((a) => a.displayName).join(' > ');
}

export function appendLog(log: HTMLOListElement, kind: LogKind, text: string): void {
  const item = document.createElement('li');
  item.dataset['kind'] = kind;
  item.textContent = text;
  log.prepend(item);
  while (log.children.length > LOG_LIMIT) log.lastElementChild?.remove();
}

export function renderList(items: HTMLElement, labels: readonly number[], selected: number): void {
  const rows = labels.map((label, index) => {
    const li = document.createElement('li');
    li.dataset['index'] = String(index);
    li.textContent = `Item ${label}`;
    if (index === selected) li.setAttribute('aria-selected', 'true');
    return li;
  });
  items.replaceChildren(...rows);
}
