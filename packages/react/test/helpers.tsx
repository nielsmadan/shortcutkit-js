import { StrictMode, type ReactNode } from 'react';
import { createRegistry, defineContext, type ShortcutRegistry } from '@shortcutkit/core';
import { ShortcutKitProvider, type ShortcutKitProviderProps } from '../src';

export const editor = defineContext({
  id: 'editor',
  displayName: 'Editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    open: { displayName: 'Open', defaults: 'mod+o' },
  },
});

export function macRegistry(): Promise<ShortcutRegistry> {
  return createRegistry({ contexts: [editor], platform: 'mac' });
}

export function pressSave(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    code: 'KeyS',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

export function strictProvider(props: Omit<ShortcutKitProviderProps, 'children'>) {
  return function Wrapper({ children }: { readonly children?: ReactNode }) {
    return (
      <StrictMode>
        <ShortcutKitProvider {...props}>{children}</ShortcutKitProvider>
      </StrictMode>
    );
  };
}
