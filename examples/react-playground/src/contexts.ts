import { defineContext, type ShortcutContext } from '@shortcutkit/core';

export const app = defineContext({
  id: 'app',
  actions: {
    commandPalette: { displayName: 'Command Palette', defaults: 'mod+k' },
    showHelp: { displayName: 'Show Help', defaults: 'shift+slash' },
    navigateBack: { displayName: 'Navigate Back', defaults: 'button4' },
    navigateForward: { displayName: 'Navigate Forward', defaults: 'button5' },
    middleClick: { displayName: 'Middle Click', defaults: 'middle-click' },
    inspect: { displayName: 'Inspect', defaults: 'shift+right-click' },
    altClick: { displayName: 'Alt Click', defaults: 'alt+left-click' },
  },
});

export const list = defineContext({
  id: 'list',
  actions: {
    goToTop: { displayName: 'Go to Top', defaults: 'g g' },
    goToEnd: { displayName: 'Go to End', defaults: 'g e' },
    nextItem: { displayName: 'Next Item', defaults: 'j' },
    previousItem: { displayName: 'Previous Item', defaults: 'k' },
    deleteItem: { displayName: 'Delete Item', defaults: 'mod+backspace', allowsKeyRepeat: false },
  },
});

export const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    togglePreview: { displayName: 'Toggle Preview', defaults: 'p' },
    leaveField: { displayName: 'Leave Field', defaults: 'escape' },
  },
});

export const contexts: readonly ShortcutContext[] = [app, list, editor];

export function findContext(id: string | undefined): ShortcutContext | undefined {
  return contexts.find((context) => context.id === id);
}
