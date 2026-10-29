const TEXT_INPUT_TYPES: ReadonlySet<string> = /* @__PURE__ */ new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

export function composedTarget(event: Event): Element | null {
  const node: unknown = event.composedPath()[0] ?? event.target;
  if (typeof node === 'object' && node !== null && (node as Node).nodeType === 1) {
    return node as Element;
  }
  return null;
}

export function isEditingText(element: Element | null): boolean {
  if (element === null) return false;
  if (element.localName === 'textarea') {
    const textarea = element as HTMLTextAreaElement;
    return !textarea.readOnly && !textarea.disabled;
  }
  if (element.localName === 'input') {
    const input = element as HTMLInputElement;
    return TEXT_INPUT_TYPES.has(input.type) && !input.readOnly && !input.disabled;
  }
  return (element as HTMLElement).isContentEditable === true;
}
