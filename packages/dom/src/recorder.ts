import {
  isBindableKeyCode,
  isModifierKeyCode,
  stepFromInput,
  type Modifiers,
  type Shortcut,
  type ShortcutRegistry,
  type Step,
} from '@shortcutkit/core';
import { altGraphUse } from './altgraph';
import { eventModifiers, keyboardInput, mouseInput } from './input';
import { consumeEvent, isNode, listenAll, whileLive } from './listeners';
import { createPressArm } from './press';
import { guardHeldInput, heldInputListeners, withHeld, type HeldInput } from './recording-guard';
import { rethrowAsync } from './rethrow';
import { createSubscribers, type Subscribers } from './subscribers';
import { composedTarget } from './text-input';

export type RecorderRejection =
  | { readonly reason: 'altGraph' }
  | { readonly reason: 'invalid'; readonly message: string; readonly shortcut: Shortcut };

export interface RecorderSnapshot {
  readonly recording: boolean;
  readonly steps: readonly Step[];
  readonly rejection: RecorderRejection | undefined;
}

export interface RecorderOptions {
  readonly onCommit: (shortcut: Shortcut) => void;
  readonly onClear?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly validate?: ((shortcut: Shortcut) => string | undefined) | undefined;
  readonly element?: Element | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly target?: EventTarget | undefined;
}

export type RecorderRegistry = Pick<ShortcutRegistry, 'suspend' | 'platform' | 'stepTimeoutMs'>;

export interface ShortcutRecorderController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => RecorderSnapshot;
  start(): void;
  cancel(): void;
  setOptions(options: RecorderOptions): void;
  dismissRejection(): void;
  destroy(): void;
}

export interface RecordingStatus {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
}

interface ActiveSlot {
  readonly preempt: () => void;
}

interface RegistryRecording {
  active: ActiveSlot | undefined;
  published: boolean;
  readonly subscribers: Subscribers;
  readonly status: RecordingStatus;
}

interface Session extends HeldInput {
  readonly target: EventTarget;
  readonly slot: ActiveSlot;
  readonly stop: () => void;
  steps: readonly Step[];
  altGraphRejected: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Ending =
  | { readonly type: 'commit'; readonly shortcut: Shortcut }
  | { readonly type: 'clear' }
  | { readonly type: 'cancel' }
  | { readonly type: 'reject'; readonly rejection: RecorderRejection };

type Validation =
  | { readonly ending: Ending; readonly thrown: false }
  | { readonly ending: Ending; readonly thrown: true; readonly error: unknown };

const IDLE: RecorderSnapshot = { recording: false, steps: [], rejection: undefined };

const recordings = /* @__PURE__ */ new WeakMap<RecorderRegistry, RegistryRecording>();

function getOrCreateRecording(registry: RecorderRegistry): RegistryRecording {
  const existing = recordings.get(registry);
  if (existing !== undefined) return existing;
  const subscribers = createSubscribers();
  const entry: RegistryRecording = {
    active: undefined,
    published: false,
    subscribers,
    status: {
      subscribe: subscribers.subscribe,
      getSnapshot: () => entry.active !== undefined,
    },
  };
  recordings.set(registry, entry);
  return entry;
}

function syncStatus(entry: RegistryRecording): void {
  const recording = entry.active !== undefined;
  if (recording === entry.published) return;
  entry.published = recording;
  entry.subscribers.notify();
}

export function recordingStatus(registry: RecorderRegistry): RecordingStatus {
  return getOrCreateRecording(registry).status;
}

function isBare(mods: Modifiers): boolean {
  return !mods.ctrl && !mods.alt && !mods.shift && !mods.meta;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(shortcut: Shortcut, message: string): Ending {
  return { type: 'reject', rejection: { reason: 'invalid', message, shortcut } };
}

function validateShortcut(validate: RecorderOptions['validate'], shortcut: Shortcut): Validation {
  let message: string | undefined;
  try {
    message = validate?.(shortcut);
  } catch (error) {
    return { ending: invalid(shortcut, errorMessage(error)), thrown: true, error };
  }
  const ending: Ending =
    message === undefined ? { type: 'commit', shortcut } : invalid(shortcut, message);
  return { ending, thrown: false };
}

function rejectionAfter(
  ending: Ending,
  previous: RecorderRejection | undefined,
): RecorderRejection | undefined {
  if (ending.type === 'reject') return ending.rejection;
  return ending.type === 'cancel' ? previous : undefined;
}

function callbackFor(ending: Ending, options: RecorderOptions): (() => void) | undefined {
  switch (ending.type) {
    case 'commit':
      return () => options.onCommit(ending.shortcut);
    case 'clear':
      return () => options.onClear?.();
    case 'cancel':
      return () => options.onCancel?.();
    case 'reject':
      return undefined;
  }
}

function focusElement(element: Element | undefined): void {
  if (element === undefined) return;
  const root = element.getRootNode() as Partial<DocumentOrShadowRoot>;
  if (root.activeElement === element) return;
  (element as Partial<HTMLElement>).focus?.({ preventScroll: true });
}

export function createShortcutRecorder(
  registry: RecorderRegistry,
  initialOptions: RecorderOptions,
): ShortcutRecorderController {
  let options = initialOptions;
  let snapshot = IDLE;
  let session: Session | undefined;
  const subscribers = createSubscribers();

  const publish = (next: RecorderSnapshot) => {
    snapshot = next;
    subscribers.notify();
  };

  const end = (ending: Ending) => {
    const current = session;
    if (current === undefined) return;
    const callback = callbackFor(ending, options);
    session = undefined;
    clearTimeout(current.timer);
    current.stop();
    const recording = getOrCreateRecording(registry);
    if (recording.active === current.slot) recording.active = undefined;
    guardHeldInput(registry, current.target, { held: current.held, press: current.press });
    publish({ recording: false, steps: [], rejection: rejectionAfter(ending, snapshot.rejection) });
    syncStatus(recording);
    // Last, so the callback sees the ended session and may start another recorder.
    try {
      callback?.();
    } catch (error) {
      rethrowAsync(error);
    }
  };

  const finalize = () => {
    const current = session;
    if (current === undefined) return;
    if (current.steps.length === 0) {
      end({ type: 'cancel' });
      return;
    }
    const validation = validateShortcut(options.validate, { steps: current.steps });
    if (session === current) end(validation.ending);
    if (validation.thrown) rethrowAsync(validation.error);
  };

  const append = (current: Session, step: Step) => {
    current.steps = [...current.steps, step];
    clearTimeout(current.timer);
    current.timer = setTimeout(finalize, options.idleTimeoutMs ?? registry.stepTimeoutMs);
    publish({ ...snapshot, steps: current.steps });
  };

  const sessionListeners = (current: Session) => {
    const onKeyDown = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.isComposing || keyEvent.keyCode === 229) return;
      consumeEvent(event);
      const { code } = keyEvent;
      current.held = withHeld(current.held, code);
      if (keyEvent.repeat || isModifierKeyCode(code)) return;
      const altGraph = altGraphUse(keyEvent, registry.platform);
      if (altGraph === 'character') {
        if (!current.altGraphRejected) {
          current.altGraphRejected = true;
          publish({ ...snapshot, rejection: { reason: 'altGraph' } });
        }
        return;
      }
      const input = keyboardInput(keyEvent);
      if (input === undefined || input.type !== 'key' || !isBindableKeyCode(code)) return;
      const mods =
        altGraph === 'ctrlAlt' ? { ...input.modifiers, ctrl: true, alt: true } : input.modifiers;
      if (isBare(mods) && code === 'Escape') {
        end({ type: 'cancel' });
        return;
      }
      const deletes = code === 'Backspace' || code === 'Delete';
      if (isBare(mods) && deletes && current.steps.length === 0) {
        end({ type: 'clear' });
        return;
      }
      append(current, stepFromInput({ ...input, modifiers: mods }));
    };

    const insideElement = (event: Event) => {
      const element = options.element;
      const node = composedTarget(event);
      return element !== undefined && node !== null && element.contains(node);
    };

    const onMouseDown = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const finalizes = mouseEvent.button === 0 && isBare(eventModifiers(mouseEvent));
      if (!finalizes || insideElement(event)) {
        consumeEvent(event);
        current.press.arm();
      }
      if (finalizes) {
        finalize();
        return;
      }
      const input = mouseInput(mouseEvent);
      if (input !== undefined) append(current, stepFromInput(input));
    };

    const onFocusOut = (event: Event) => {
      const element = options.element;
      const from = composedTarget(event);
      const to = (event as FocusEvent).relatedTarget;
      if (element === undefined || from === null || !element.contains(from)) return;
      if (isNode(to) && element.contains(to)) return;
      finalize();
    };

    const { target } = current;
    return listenAll(
      whileLive(
        () => session === current,
        [
          ...heldInputListeners(target, current, {
            keydown: onKeyDown,
            mousedown: onMouseDown,
            exit: finalize,
          }),
          [target, 'focusout', onFocusOut, true],
        ],
      ),
    );
  };

  const start = () => {
    if (session !== undefined) return;
    const target = options.target ?? window;
    const release = registry.suspend();
    const current: Session = {
      target,
      slot: {
        preempt: () => {
          if (session === current) end({ type: 'cancel' });
        },
      },
      stop: () => {
        stopListening();
        release();
      },
      steps: [],
      held: new Set(),
      press: createPressArm(),
      altGraphRejected: false,
      timer: undefined,
    };
    const stopListening = sessionListeners(current);
    session = current;
    const recording = getOrCreateRecording(registry);
    const previous = recording.active;
    recording.active = current.slot;
    // The preempted recorder's onCancel and the element's focus handlers can end this session.
    previous?.preempt();
    if (session !== current) return;
    focusElement(options.element);
    if (session !== current) return;
    publish({ recording: true, steps: [], rejection: snapshot.rejection });
    syncStatus(recording);
  };

  const cancel = () => {
    end({ type: 'cancel' });
  };

  const dismissRejection = () => {
    if (snapshot.rejection === undefined) return;
    if (session !== undefined) session.altGraphRejected = false;
    publish({ ...snapshot, rejection: undefined });
  };

  return {
    subscribe: subscribers.subscribe,
    getSnapshot: () => snapshot,
    start,
    cancel,
    setOptions: (next) => {
      options = next;
    },
    dismissRejection,
    destroy: cancel,
  };
}
