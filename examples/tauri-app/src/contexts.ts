import { defineContext, type ShortcutContext } from '@shortcutkit/core';

export const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    find: { displayName: 'Find', defaults: 'mod+f' },
    goToTop: { displayName: 'Go to Top', defaults: 'g g' },
  },
});

export const app = defineContext({
  id: 'app',
  scope: 'global',
  actions: {
    showWindow: { displayName: 'Show Window', defaults: 'ctrl+alt+meta+k' },
  },
});

export const contexts: readonly ShortcutContext[] = [editor, app];

export function findContext(id: string | undefined): ShortcutContext | undefined {
  return contexts.find((context) => context.id === id);
}
