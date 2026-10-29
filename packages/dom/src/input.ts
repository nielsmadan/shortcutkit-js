import {
  isModifierKeyCode,
  type Modifiers,
  type ShortcutInput,
  type ShortcutRegistry,
} from '@shortcutkit/core';
import { rethrowAsync } from './rethrow';
import { composedTarget, isEditingText } from './text-input';

export interface AttachInputOptions {
  readonly target?: EventTarget | undefined;
  readonly stopPropagation?: boolean | undefined;
}

const PRESS_FOLLOW_UP_EVENTS = ['mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const;

function eventModifiers(event: KeyboardEvent | MouseEvent): Modifiers {
  return { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
}

export function keyboardInput(event: KeyboardEvent): ShortcutInput | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (typeof event.code !== 'string' || event.code === '') return undefined;
  return {
    type: 'key',
    code: event.code,
    modifiers: eventModifiers(event),
    repeat: event.repeat,
    editingText: isEditingText(composedTarget(event)),
  };
}

export function mouseInput(event: MouseEvent): ShortcutInput | undefined {
  if (typeof event.button !== 'number') return undefined;
  if (event.button < 0 || event.button > 4) return undefined;
  return { type: 'mouse', button: event.button, modifiers: eventModifiers(event) };
}

export function attachInput(
  registry: Pick<ShortcutRegistry, 'handleInput'>,
  options: AttachInputOptions = {},
): () => void {
  const target = options.target ?? window;
  const stopPropagation = options.stopPropagation ?? true;
  let pressArmed = false;

  const consume = (event: Event) => {
    event.preventDefault();
    if (stopPropagation) event.stopPropagation();
  };

  const route = (event: Event, input: ShortcutInput): boolean => {
    let result;
    try {
      result = registry.handleInput(input);
    } catch (error) {
      consume(event);
      rethrowAsync(error);
      return true;
    }
    if (result === 'ignored') return false;
    consume(event);
    return true;
  };

  const onKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    if (!keyEvent.repeat && !isModifierKeyCode(keyEvent.code)) pressArmed = false;
    if (event.defaultPrevented) return;
    const input = keyboardInput(keyEvent);
    if (input) route(event, input);
  };

  const onMouseDown = (event: Event) => {
    pressArmed = false;
    if (event.defaultPrevented) return;
    const input = mouseInput(event as MouseEvent);
    if (input && route(event, input)) pressArmed = true;
  };

  const onPointerDown = () => {
    pressArmed = false;
  };

  const onFollowUp = (event: Event) => {
    if (pressArmed) consume(event);
  };

  const listeners: readonly (readonly [string, (event: Event) => void])[] = [
    ['keydown', onKeyDown],
    ['pointerdown', onPointerDown],
    ['mousedown', onMouseDown],
    ...PRESS_FOLLOW_UP_EVENTS.map((type) => [type, onFollowUp] as const),
  ];
  listeners.forEach(([type, listener]) =>
    target.addEventListener(type, listener, { capture: true }),
  );
  return () => {
    listeners.forEach(([type, listener]) =>
      target.removeEventListener(type, listener, { capture: true }),
    );
  };
}
