# @shortcutkit/react

React bindings for `@shortcutkit/core` and `@shortcutkit/dom`: a provider that attaches browser input, hooks that read the registry's snapshot and shortcut labels, hooks that activate contexts while a component is mounted or focused, and a field that records shortcuts. Pre-alpha; the API will change.

```bash
pnpm add @shortcutkit/core @shortcutkit/dom @shortcutkit/react
```

ESM only, ES2023; needs the DOM lib. React 18 or 19. Install the same version of the three packages.

```tsx
import { createRegistry, defineContext } from '@shortcutkit/core';
import { ShortcutKitProvider, useShortcuts } from '@shortcutkit/react';
import { renderToString } from 'react-dom/server';

const editor = defineContext({
  id: 'editor',
  actions: { save: { displayName: 'Save', defaults: 'mod+s' } },
});

function SaveHint() {
  const { labels } = useShortcuts(editor, 'save');
  return <kbd>{labels[0]}</kbd>;
}

const registry = await createRegistry({ contexts: [editor], platform: 'mac' });
const html = renderToString(
  <ShortcutKitProvider registry={registry} input={false}>
    <SaveHint />
  </ShortcutKitProvider>,
);
console.log(html.replace(/<[^>]*>/g, ''));
```

The example renders on the server, so it passes `input={false}` and strips the markup to print `⌘S`. In the browser, create the registry before the first render, usually with `localStorageStore()` and `syncRegistry` from `@shortcutkit/dom`, and render with `createRoot`.

## Provider

`<ShortcutKitProvider registry={registry}>` makes the registry available to the hooks below and calls `attachInput(registry)` from `@shortcutkit/dom` while it is mounted. Pass `input={false}` to attach input yourself, or an object such as `input={{ target: element }}` to pass options to `attachInput`. Input is re-attached only when the registry, `target` or `stopPropagation` changes, so an inline object is fine.

Labels use `registry.platform` and the US layout. To label keys with the user's layout, pass a store with `subscribe` and `getSnapshot`, such as `keyboardLayoutProvider()` from `@shortcutkit/dom`, as `layout`. Create it once, outside the component or in `useState`, not on every render.

Hooks used outside the provider throw `ShortcutKit hooks need a <ShortcutKitProvider>`.

## Reading state

All of these re-render when the registry publishes a new snapshot, and work in server rendering.

- `useRegistry()` returns the registry, for calls such as `setShortcuts`, `reset` or `dispatch`.
- `useRegistrySnapshot()` returns the registry's snapshot: key bindings, conflicts, hint preferences and active contexts.
- `useKeyBindings()` and `useConflicts()` return those two parts of the snapshot.
- `useShortcuts(context, action)` returns `{ shortcuts, labels, isCustomized }` for one action. The object stays the same until the snapshot or the layout changes. Every activation change publishes a new snapshot, so do not use it as an effect dependency.
- `useShortcutLabel(shortcut)` returns the label of any shortcut, such as `⇧⌘S` on a Mac and `Ctrl+Shift+S` elsewhere.

## Activating contexts

`useShortcutContext(context, handler, { enabled })` activates `context` while the component is mounted and `enabled` is not `false`. The handler receives the action id. A new handler on each render is fine: the latest one runs, and the context is not re-activated.

```tsx
function Editor() {
  useShortcutContext(editor, (action) => {
    if (action === 'save') save();
  });
  return <textarea />;
}
```

`useFocusShortcutContext(context, handler)` activates `context` while focus is inside an element. Spread its result onto that element: focus moving between its descendants keeps the context active, and focus leaving it, or unmounting, deactivates it.

```tsx
function List() {
  const focusProps = useFocusShortcutContext(list, (action) => console.log(action));
  return <ul tabIndex={0} {...focusProps} />;
}
```

The newest activation is innermost and wins ties. React runs effects children first, so when a parent and a child activate in the same commit, the parent activates last and wins ties with the child. A child that mounts later, or a focus context that activates on focus, is newer and wins.

## Recording shortcuts

`<ShortcutRecorder value={shortcut} onChange={setShortcut} />` is a field that records a new shortcut. It is unstyled: it renders semantic markup with class names and `data-*` attributes for your CSS.

```tsx
function SaveBinding() {
  const { shortcuts } = useShortcuts(editor, 'save');
  const registry = useRegistry();
  const [first, ...rest] = shortcuts;
  return (
    <ShortcutRecorder
      aria-label="Save shortcut"
      value={first}
      onChange={(next) =>
        registry.setShortcuts(editor, 'save', next === undefined ? rest : [next, ...rest])
      }
    />
  );
}
```

Clicking the field, or pressing Enter or Space on it, starts recording. While recording, every key press becomes a step, the provider's bindings do not fire, and the field shows the steps so far followed by `…`. Recording ends when no key is pressed for the registry's step timeout, on a click, or when focus leaves the field; the shortcut then goes to `onChange`. Escape cancels. Backspace or Delete before the first step calls `onChange(undefined)`, as does the clear button. Holding a key past the end of a recording does not repeat the shortcut just recorded. Focus stays on the field afterwards.

Props:

- `value` and `onChange`: the shortcut shown, and the callback receiving a recorded shortcut or `undefined` when cleared.
- `scope`: pass `'global'` for a global context, which rejects multi-step and mouse shortcuts.
- `validate(shortcut)`: return a message to reject a shortcut, or `undefined` to accept it. Clashes with other actions are not rejected here; they appear in the registry's conflicts after saving.
- `placeholder` (default `Record Shortcut`) and `recordingPlaceholder` (default `Record shortcut…`): the text with no value, idle and recording.
- `disabled`: disables both buttons and cancels a recording in progress.
- `id` and `aria-label` go on the field button; `className` is added to the wrapper.

Markup:

```html
<span class="shortcut-recorder" data-recording="false" data-empty="false">
  <button
    type="button"
    class="shortcut-recorder-field"
    aria-label="Save shortcut"
    aria-describedby="…"
    aria-pressed="false"
  >
    ⌘S
  </button>
  <span id="…" hidden>⌘S</span>
  <button type="button" class="shortcut-recorder-clear" aria-label="Clear shortcut">×</button>
  <span id="…" class="shortcut-recorder-error" role="alert">…</span>
</span>
```

`aria-pressed` is `"true"` while recording. With `aria-label`, a hidden span repeats the field's text so the field's description still announces the value. The clear button is rendered while there is a value and no steps are being recorded. The error caption is rendered when a recording is rejected, by `scope`, `validate`, or a character typed with AltGr, until the next accepted recording, the clear button, or a new `value`. The field's `aria-describedby` lists the hidden span and the caption while they are rendered. `data-recording` and `data-empty` are `"true"` or `"false"`. A starting point:

```css
.shortcut-recorder {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
}
.shortcut-recorder-field {
  min-width: 8rem;
  font: inherit;
}
.shortcut-recorder[data-empty='true']:not([data-recording='true']) .shortcut-recorder-field {
  color: GrayText;
}
.shortcut-recorder[data-recording='true'] .shortcut-recorder-field {
  outline: 2px solid AccentColor;
}
.shortcut-recorder-error {
  flex-basis: 100%;
  color: #c00;
  font-size: 0.875em;
}
```

Enter and Space start a recording through the browser's button activation, after the provider has seen the key. While an active context binds bare Enter or Space, the provider consumes that key and a focused idle recorder cannot be started from the keyboard; it still starts on click.

`useIsRecording()` is `true` while any recorder of the provider's registry is recording, for example to show an indicator or hide hints. Starting a recorder cancels any other one of the same registry.

`useShortcutRecorder({ onCommit, onClear, onCancel, validate, idleTimeoutMs })` is the hook behind the component, for building your own field. It returns a `UseShortcutRecorderResult`, `{ recording, steps, rejection, ref, start, cancel, dismissRejection }`: put `ref` on the element that receives focus while recording, call `start()` from its click handler, and call `dismissRejection()` to hide a rejection that no longer applies, such as after the value changes. The latest options are used whenever an event arrives. It listens on `window` whatever the provider's `input` target, so a field in a portal records too.
