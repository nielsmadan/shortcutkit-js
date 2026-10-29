// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { composedTarget, isEditingText } from '../src';

afterEach(() => {
  document.body.replaceChildren();
});

function input(type?: string): HTMLInputElement {
  const element = document.createElement('input');
  if (type !== undefined) element.setAttribute('type', type);
  document.body.append(element);
  return element;
}

function element(
  tag: string,
  attributes: Record<string, string> = {},
  parent: Element = document.body,
) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  parent.append(node);
  return node;
}

const TEXT_TYPES = [
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
];

const NON_TEXT_TYPES = [
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'submit',
  'reset',
  'button',
  'image',
  'hidden',
];

describe('isEditingText', () => {
  it.each(TEXT_TYPES)('is true for an input of type %s', (type) => {
    expect(isEditingText(input(type))).toBe(true);
  });

  it('is true for an input with no type', () => {
    expect(isEditingText(input())).toBe(true);
  });

  it.each(['foo', 'TEXT'])('is true for an input whose type attribute is %s', (type) => {
    expect(isEditingText(input(type))).toBe(true);
  });

  it('is true for a textarea', () => {
    expect(isEditingText(element('textarea'))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    expect(isEditingText(element('div', { contenteditable: 'true' }))).toBe(true);
  });

  it('is true for a span inside a contenteditable element', () => {
    const editor = element('div', { contenteditable: 'true' });
    expect(isEditingText(element('span', {}, editor))).toBe(true);
  });

  it('is true for a plaintext-only contenteditable element', () => {
    expect(isEditingText(element('div', { contenteditable: 'plaintext-only' }))).toBe(true);
  });

  it.each(NON_TEXT_TYPES)('is false for an input of type %s', (type) => {
    expect(isEditingText(input(type))).toBe(false);
  });

  it.each(['button', 'div', 'select'])('is false for a %s', (tag) => {
    expect(isEditingText(element(tag))).toBe(false);
  });

  it('is false for the body', () => {
    expect(isEditingText(document.body)).toBe(false);
  });

  it('is false for null', () => {
    expect(isEditingText(null)).toBe(false);
  });

  it.each([
    ['input', 'readonly'],
    ['input', 'disabled'],
    ['textarea', 'readonly'],
    ['textarea', 'disabled'],
  ])('is false for a %s that is %s', (tag, attribute) => {
    expect(isEditingText(element(tag, { [attribute]: '' }))).toBe(false);
  });

  it('is false for a contenteditable="false" child of an editable parent', () => {
    const editor = element('div', { contenteditable: 'true' });
    expect(isEditingText(element('span', { contenteditable: 'false' }, editor))).toBe(false);
  });
});

describe('composedTarget', () => {
  const stub = (path: unknown[], target: unknown) =>
    ({ composedPath: () => path, target }) as unknown as Event;

  it('prefers the first node of the composed path', () => {
    const field = input();
    const host = element('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    expect(composedTarget(stub([field, shadowRoot, host], host))).toBe(field);
  });

  it('falls back to the target when the path is empty', () => {
    const field = input();
    expect(composedTarget(stub([], field))).toBe(field);
  });

  it('is null for a non-element target', () => {
    expect(composedTarget(stub([window], window))).toBeNull();
  });

  it('a real shadow root input counts as editing', () => {
    const host = element('div');
    const field = document.createElement('input');
    host.attachShadow({ mode: 'open' }).append(field);
    let editing: boolean | undefined;
    const listener = (event: Event) => {
      editing = isEditingText(composedTarget(event));
    };
    window.addEventListener('keydown', listener);
    try {
      field.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyA',
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    } finally {
      window.removeEventListener('keydown', listener);
    }
    expect(editing).toBe(true);
  });
});
