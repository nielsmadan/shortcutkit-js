import { type Modifiers, type ShortcutInput, type ShortcutRegistry } from '@shortcutkit/core';
import { listenAll } from './listeners';
import { createPressArm, pressListeners } from './press';
import { rethrowAsync } from './rethrow';
import { composedTarget, isEditingText } from './text-input';

export interface AttachInputOptions {
  readonly target?: EventTarget | undefined;
  readonly stopPropagation?: boolean | undefined;
}

export function eventModifiers(event: KeyboardEvent | MouseEvent): Modifiers {
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

function activatesButton(event: KeyboardEvent): boolean {
  if (event.code !== 'Enter' && event.code !== 'Space') return false;
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return false;
  const element = composedTarget(event);
  if (element?.localName === 'button') return true;
  return (
    element?.localName === 'input' &&
    ['button', 'submit', 'reset'].includes((element as HTMLInputElement).type)
  );
}

export function attachInput(
  registry: Pick<ShortcutRegistry, 'handleInput'>,
  options: AttachInputOptions = {},
): () => void {
  const target = options.target ?? window;
  const stopPropagation = options.stopPropagation ?? true;
  const press = createPressArm();

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
    if (event.defaultPrevented) return;
    const keyEvent = event as KeyboardEvent;
    if (activatesButton(keyEvent)) return;
    const input = keyboardInput(keyEvent);
    if (input) route(event, input);
  };

  const onMouseDown = (event: Event) => {
    if (event.defaultPrevented) return;
    const input = mouseInput(event as MouseEvent);
    if (input && route(event, input)) press.arm();
  };

  return listenAll(
    pressListeners(target, press, consume, { keydown: onKeyDown, mousedown: onMouseDown }),
  );
}
