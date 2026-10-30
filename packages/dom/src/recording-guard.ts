// Portions adapted from TanStack Hotkeys (MIT); see THIRD_PARTY_NOTICES.md
import { isModifierKeyCode, type ShortcutRegistry } from '@shortcutkit/core';
import {
  consumeEvent,
  listenAll,
  pageExitListeners,
  whileLive,
  type ListenerEntry,
} from './listeners';
import { pressListeners, type PressArm, type PressHandlers } from './press';

export interface HeldInput {
  held: ReadonlySet<string>;
  readonly press: PressArm;
}

export interface HeldInputHandlers extends PressHandlers {
  readonly keyup?: (() => void) | undefined;
  readonly exit: (event: Event) => void;
}

function holdsKey(code: string): boolean {
  return code !== '' && code !== 'ScrollLock' && !isModifierKeyCode(code);
}

function without(codes: ReadonlySet<string>, code: string): ReadonlySet<string> {
  return codes.has(code) ? new Set([...codes].filter((held) => held !== code)) : codes;
}

export function withHeld(codes: ReadonlySet<string>, code: string): ReadonlySet<string> {
  return holdsKey(code) && !codes.has(code) ? new Set([...codes, code]) : codes;
}

function afterKeyUp(codes: ReadonlySet<string>, code: string): ReadonlySet<string> {
  // macOS can drop the main key's keyup while Command is held, so a modifier release ends the chord.
  if (isModifierKeyCode(code)) return codes.size === 0 ? codes : new Set();
  return without(codes, code);
}

export function heldInputListeners(
  target: EventTarget,
  state: HeldInput,
  handlers: HeldInputHandlers,
): ListenerEntry[] {
  const onKeyUp = (event: Event) => {
    const { code } = event as KeyboardEvent;
    if (state.held.has(code)) consumeEvent(event);
    state.held = afterKeyUp(state.held, code);
    handlers.keyup?.();
  };
  return [
    ...pressListeners(target, state.press, consumeEvent, handlers),
    [target, 'keyup', onKeyUp, true],
    ...pageExitListeners(target, handlers.exit),
  ];
}

export function guardHeldInput(
  registry: Pick<ShortcutRegistry, 'suspend'>,
  target: EventTarget,
  held: HeldInput,
): void {
  if (held.held.size === 0 && !held.press.armed) return;
  const state: HeldInput = { ...held };
  let ended = false;

  const release = registry.suspend(
    (input) => input.type === 'key' && input.repeat === true && state.held.has(input.code),
  );

  const end = () => {
    if (ended) return;
    ended = true;
    release();
    stopListening();
  };

  const settle = () => {
    if (state.held.size === 0 && !state.press.armed) end();
  };

  const onKeyDown = (event: Event) => {
    const { code, repeat } = event as KeyboardEvent;
    if (repeat) {
      if (state.held.has(code)) consumeEvent(event);
      return;
    }
    if (isModifierKeyCode(code)) return;
    state.held = without(state.held, code);
    settle();
  };

  const stopListening = listenAll(
    whileLive(
      () => !ended,
      heldInputListeners(target, state, {
        keydown: onKeyDown,
        pointerdown: settle,
        mousedown: settle,
        keyup: settle,
        exit: end,
      }),
    ),
  );
}
