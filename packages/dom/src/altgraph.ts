// Portions adapted from TanStack Hotkeys (MIT); see THIRD_PARTY_NOTICES.md
import type { Platform } from '@shortcutkit/core';

export type AltGraphUse = 'none' | 'character' | 'ctrlAlt';

function altGraphHeld(event: KeyboardEvent, platform: Platform): boolean {
  // WebKit reports AltGraph for Option on some macOS layouts, where Option stays a plain Alt.
  if (platform === 'mac') return false;
  try {
    return typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
  } catch {
    return false;
  }
}

function typedCharacter(key: string): boolean {
  if (key === 'Dead') return true;
  if (key === ' ') return false;
  return Array.from(key).length === 1 && !/^[A-Za-z0-9]$/.test(key);
}

export function altGraphUse(event: KeyboardEvent, platform: Platform): AltGraphUse {
  if (!altGraphHeld(event, platform)) return 'none';
  // Windows reports AltGr as Ctrl+Alt; when it typed nothing new (AltGr+Home) it is that shortcut.
  const key = (event.key || '').normalize('NFC');
  if (platform === 'windows' && !typedCharacter(key)) return 'ctrlAlt';
  return 'character';
}
