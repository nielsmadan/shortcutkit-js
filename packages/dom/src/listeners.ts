export type ListenerEntry = readonly [
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
  capture: boolean,
];

export function listenAll(entries: readonly ListenerEntry[]): () => void {
  entries.forEach(([target, type, listener, capture]) =>
    target.addEventListener(type, listener, { capture }),
  );
  return () =>
    entries.forEach(([target, type, listener, capture]) =>
      target.removeEventListener(type, listener, { capture }),
    );
}

export function whileLive(
  isLive: () => boolean,
  entries: readonly ListenerEntry[],
): ListenerEntry[] {
  return entries.map(([target, type, listener, capture]): ListenerEntry => [
    target,
    type,
    (event) => {
      if (isLive()) listener(event);
    },
    capture,
  ]);
}

export function consumeEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof (value as Node).nodeType === 'number'
  );
}

function ownerWindow(target: EventTarget): Window | undefined {
  const view = target as Partial<Window>;
  if (view.window === target) return target as Window;
  if (!isNode(target)) return undefined;
  const document =
    target.nodeType === Node.DOCUMENT_NODE ? (target as Document) : target.ownerDocument;
  return document?.defaultView ?? undefined;
}

export function pageExitListeners(
  target: EventTarget,
  onExit: (event: Event) => void,
): ListenerEntry[] {
  const view = ownerWindow(target);
  const onBlur = (event: Event) => {
    if (event.eventPhase === Event.AT_TARGET) onExit(event);
  };
  const onVisibilityChange = (event: Event) => {
    if (view?.document.visibilityState === 'hidden') onExit(event);
  };
  const blur: ListenerEntry = [view ?? target, 'blur', onBlur, false];
  if (view === undefined) return [blur];
  return [
    blur,
    [view.document, 'visibilitychange', onVisibilityChange, false],
    [view, 'pagehide', onExit, false],
  ];
}
