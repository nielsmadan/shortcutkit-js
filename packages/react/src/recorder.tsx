import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type RefCallback,
} from 'react';
import {
  describeUnsupported,
  formatShortcut,
  shortcutLabel,
  unsupportedInScope,
  type ContextScope,
  type Shortcut,
} from '@shortcutkit/core';
import {
  createShortcutRecorder,
  recordingStatus,
  type RecorderOptions,
  type RecorderRejection,
  type RecorderSnapshot,
} from '@shortcutkit/dom';
import { useLatest } from './latest';
import { useLayoutSnapshot, useShortcutKit } from './provider';

export function useIsRecording(): boolean {
  const { registry } = useShortcutKit();
  const status = recordingStatus(registry);
  return useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot);
}

export type UseShortcutRecorderResult = RecorderSnapshot & {
  readonly ref: RefCallback<HTMLElement>;
  start(): void;
  cancel(): void;
  dismissRejection(): void;
};

export function useShortcutRecorder(
  options: Omit<RecorderOptions, 'target' | 'element'>,
): UseShortcutRecorderResult {
  const { registry } = useShortcutKit();
  const latest = useLatest(options);
  const element = useRef<HTMLElement | undefined>(undefined);
  const controller = useMemo(
    () =>
      createShortcutRecorder(registry, {
        onCommit: (shortcut) => latest.current.onCommit(shortcut),
        onClear: () => latest.current.onClear?.(),
        onCancel: () => latest.current.onCancel?.(),
        validate: (shortcut) => latest.current.validate?.(shortcut),
        get idleTimeoutMs() {
          return latest.current.idleTimeoutMs;
        },
        get element() {
          return element.current;
        },
      }),
    [registry, latest],
  );

  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node ?? undefined;
  }, []);

  useEffect(() => () => controller.destroy(), [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return useMemo(
    () => ({
      ...snapshot,
      ref,
      start: controller.start,
      cancel: controller.cancel,
      dismissRejection: controller.dismissRejection,
    }),
    [snapshot, ref, controller],
  );
}

export interface ShortcutRecorderProps {
  readonly value: Shortcut | undefined;
  readonly onChange: (value: Shortcut | undefined) => void;
  readonly scope?: ContextScope | undefined;
  readonly validate?: ((shortcut: Shortcut) => string | undefined) | undefined;
  readonly placeholder?: string | undefined;
  readonly recordingPlaceholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
  readonly 'aria-label'?: string | undefined;
}

function scopedValidator(
  scope: ContextScope | undefined,
  validate: ((shortcut: Shortcut) => string | undefined) | undefined,
): (shortcut: Shortcut) => string | undefined {
  return (shortcut) => {
    const reason = scope === undefined ? undefined : unsupportedInScope(shortcut, scope);
    return reason === undefined ? validate?.(shortcut) : describeUnsupported(reason);
  };
}

function useAnnouncementKey(rejection: RecorderRejection | undefined): number {
  const [announced, setAnnounced] = useState({ rejection, key: 0 });
  if (announced.rejection === rejection) return announced.key;
  const next = { rejection, key: rejection === undefined ? announced.key : announced.key + 1 };
  setAnnounced(next);
  return next.key;
}

function rejectionMessage(rejection: RecorderRejection): string {
  return rejection.reason === 'altGraph' ? "AltGr characters can't be recorded" : rejection.message;
}

export function ShortcutRecorder({
  value,
  onChange,
  scope,
  validate,
  placeholder = 'Record Shortcut',
  recordingPlaceholder = 'Record shortcut…',
  disabled = false,
  id,
  className,
  'aria-label': ariaLabel,
}: ShortcutRecorderProps): ReactElement {
  const { registry } = useShortcutKit();
  const layout = useLayoutSnapshot();
  const captionId = useId();
  const valueId = useId();
  const { recording, steps, rejection, ref, start, cancel, dismissRejection } = useShortcutRecorder(
    {
      onCommit: (shortcut) => onChange(shortcut),
      onClear: () => onChange(undefined),
      validate: scopedValidator(scope, validate),
    },
  );

  const fieldRef = useRef<HTMLButtonElement | null>(null);
  const setField = useCallback(
    (node: HTMLButtonElement | null) => {
      fieldRef.current = node;
      ref(node);
    },
    [ref],
  );

  const valueKey = value === undefined ? '' : formatShortcut(value);
  const announcementKey = useAnnouncementKey(rejection);

  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  useEffect(() => {
    dismissRejection();
  }, [valueKey, dismissRejection]);

  const label = (shortcut: Shortcut) =>
    shortcutLabel(shortcut, { platform: registry.platform, layout });
  const idleText = value === undefined ? placeholder : label(value);
  const recordingText =
    steps.length > 0
      ? `${label({ steps })} …`
      : value === undefined
        ? recordingPlaceholder
        : label(value);

  const fieldText = recording ? recordingText : idleText;
  const describedBy = [
    ariaLabel === undefined ? undefined : valueId,
    rejection === undefined ? undefined : captionId,
  ]
    .filter((part) => part !== undefined)
    .join(' ');

  return (
    <span
      className={className === undefined ? 'shortcut-recorder' : `shortcut-recorder ${className}`}
      data-recording={recording}
      data-empty={value === undefined}
    >
      <button
        ref={setField}
        type="button"
        className="shortcut-recorder-field"
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        aria-pressed={recording}
        disabled={disabled}
        onClick={() => {
          if (!recording) start();
        }}
      >
        {fieldText}
      </button>
      {ariaLabel !== undefined && (
        <span id={valueId} hidden>
          {fieldText}
        </span>
      )}
      {value !== undefined && steps.length === 0 && (
        <button
          type="button"
          className="shortcut-recorder-clear"
          aria-label="Clear shortcut"
          disabled={disabled}
          onClick={() => {
            fieldRef.current?.focus();
            dismissRejection();
            onChange(undefined);
          }}
        >
          ×
        </button>
      )}
      {rejection !== undefined && (
        <span key={announcementKey} id={captionId} className="shortcut-recorder-error" role="alert">
          {rejectionMessage(rejection)}
        </span>
      )}
    </span>
  );
}
