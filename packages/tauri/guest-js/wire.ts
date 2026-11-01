import type { Modifiers } from '@shortcutkit/core';

export interface WireKey {
  readonly code: string;
  readonly modifiers: Modifiers;
}
