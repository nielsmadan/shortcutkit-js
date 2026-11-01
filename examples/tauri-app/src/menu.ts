import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import type { Platform, ShortcutRegistry } from '@shortcutkit/core';
import {
  predefinedMenuShortcuts,
  syncMenuAccelerators,
  type MenuBinding,
  type PredefinedMenuItemKind,
} from '@shortcutkit/tauri';
import { editor } from './contexts';

const EDIT_KINDS = [
  'Undo',
  'Redo',
  'Cut',
  'Copy',
  'Paste',
  'SelectAll',
] as const satisfies readonly PredefinedMenuItemKind[];

const STATIC_KINDS: readonly PredefinedMenuItemKind[] = ['Quit', ...EDIT_KINDS];

export const staticMenuShortcuts = (platform: Platform) =>
  predefinedMenuShortcuts(platform, STATIC_KINDS);

export interface AppMenu {
  readonly bindings: readonly MenuBinding[];
  readonly stop: () => void;
}

export async function buildAppMenu(registry: ShortcutRegistry): Promise<AppMenu> {
  const entries = await Promise.all(
    editor.actionIds.map(async (action) => ({
      item: await MenuItem.new({
        text: editor.actions[action].displayName,
        action: () => registry.dispatch(editor, action),
      }),
      context: editor,
      action,
    })),
  );
  const bindings: readonly MenuBinding[] = entries;
  const appSubmenu = await Submenu.new({
    text: 'ShortcutKit Example',
    items: [await PredefinedMenuItem.new({ item: 'Quit' })],
  });
  const editSubmenu = await Submenu.new({
    text: 'Edit',
    items: await Promise.all(EDIT_KINDS.map((item) => PredefinedMenuItem.new({ item }))),
  });
  const shortcutsSubmenu = await Submenu.new({
    text: 'Shortcuts',
    items: entries.map(({ item }) => item),
  });
  const menu = await Menu.new({ items: [appSubmenu, editSubmenu, shortcutsSubmenu] });
  await menu.setAsAppMenu();
  return { bindings, stop: syncMenuAccelerators(registry, bindings) };
}
