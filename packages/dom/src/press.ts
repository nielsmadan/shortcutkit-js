import { isModifierKeyCode } from '@shortcutkit/core';
import type { ListenerEntry } from './listeners';

const PRESS_FOLLOW_UP_EVENTS = ['mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const;

export interface PressArm {
  readonly armed: boolean;
  arm(): void;
  observe(event: Event): void;
}

export interface PressHandlers {
  readonly keydown?: ((event: Event) => void) | undefined;
  readonly pointerdown?: ((event: Event) => void) | undefined;
  readonly mousedown?: ((event: Event) => void) | undefined;
}

function disarmsPress(event: Event): boolean {
  if (event.type === 'pointerdown' || event.type === 'mousedown') return true;
  if (event.type !== 'keydown') return false;
  const { repeat, code } = event as KeyboardEvent;
  return !repeat && !isModifierKeyCode(code);
}

export function createPressArm(armed = false): PressArm {
  let state = armed;
  return {
    get armed() {
      return state;
    },
    arm: () => {
      state = true;
    },
    observe: (event) => {
      if (disarmsPress(event)) state = false;
    },
  };
}

export function pressListeners(
  target: EventTarget,
  press: PressArm,
  consume: (event: Event) => void,
  handlers: PressHandlers,
): ListenerEntry[] {
  const observed =
    (handler: ((event: Event) => void) | undefined) =>
    (event: Event): void => {
      press.observe(event);
      handler?.(event);
    };
  const onFollowUp = (event: Event) => {
    if (press.armed) consume(event);
  };
  return [
    [target, 'keydown', observed(handlers.keydown), true],
    [target, 'pointerdown', observed(handlers.pointerdown), true],
    [target, 'mousedown', observed(handlers.mousedown), true],
    ...PRESS_FOLLOW_UP_EVENTS.map((type): ListenerEntry => [target, type, onFollowUp, true]),
  ];
}
