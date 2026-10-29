# @shortcutkit/dom

Browser input for `@shortcutkit/core`: keyboard and mouse listeners, text-input and IME gating, keyboard layout lookup and localStorage persistence. Pre-alpha; the API will change.

```bash
pnpm add @shortcutkit/core @shortcutkit/dom
```

ESM only, ES2023; needs the DOM lib. Install the same version of both packages.

```ts
import { createRegistry, defineContext, syncRegistry } from '@shortcutkit/core';
import { attachInput, detectPlatform, localStorageStore } from '@shortcutkit/dom';

const list = defineContext({
  id: 'list',
  actions: { goToTop: { displayName: 'Go to Top', defaults: 'g g' } },
});

const store = localStorageStore();
const registry = await createRegistry({ contexts: [list], platform: detectPlatform(), store });
syncRegistry(registry, store);
registry.activate(list, (action) => console.log(action));
attachInput(registry);

for (const code of ['KeyG', 'KeyG']) {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }),
  );
}
```

The loop simulates typing `g g`.

## Input

`attachInput(registry, options?)` adds capture-phase listeners for `keydown`, `pointerdown`, `mousedown` and the follow-up mouse events on `window`, or on `options.target`. It returns a function that removes them.

Events that are already `defaultPrevented` are skipped. A listener that claims events this way must be registered on `window` in the capture phase before `attachInput`'s listeners. When the registry fires or advances a sequence, the event is consumed: `preventDefault` plus `stopPropagation`. Pass `stopPropagation: false` to keep the event propagating. A handler that throws still consumes the event, and its error is rethrown asynchronously.

The rest of a press: after a consumed `mousedown`, the `mouseup`, `click`, `auxclick`, `dblclick` and `contextmenu` events that follow are consumed too, and the prevented `mousedown` also blocks focus, text selection and drag start for that press. The suppression ends at the next `pointerdown`, `mousedown`, or non-repeating, non-modifier `keydown`, including one an earlier listener already prevented.

Text inputs: `textarea`, and `input` of type `text`, `search`, `email`, `url`, `tel`, `password`, `number`, `date`, `time`, `datetime-local`, `month` or `week`, unless read-only or disabled, plus `contenteditable` elements, count as editing text. The target is read through `composedPath()`, so open shadow roots work. The registry receives `editingText` and decides what fires. Key events during IME composition (`isComposing` or `keyCode` 229) are ignored. Mouse buttons 0 to 4 are routed.

Known gaps:

- Closed shadow roots are not seen into.
- `keyup` and pointer events of a consumed input still reach the page.
- On Windows and Linux, AltGr reports Ctrl+Alt, so `ctrl+alt+<key>` bindings fire while typing AltGr characters.
- A script's `element.click()` between a consumed press and the next press or key is consumed too.

## Keyboard layout

`keyboardLayoutProvider()` returns a provider with `subscribe`, `getSnapshot` and `refresh`. The first lookup starts on the first `subscribe` or `refresh()`, so read `getSnapshot()` from a subscriber. The snapshot is the US layout until a lookup succeeds; pass `provider.getSnapshot()` as `layout` to core's label functions, such as `shortcutLabel` and `stepLabel`. The lookup uses `navigator.keyboard.getLayoutMap`, which is Chromium-only and needs a secure context; elsewhere the US layout stays. The layout refreshes on window focus while someone is subscribed, and a failed lookup warns once through the `logger` option, which defaults to the console. A host can pass its own `load` to supply the map.

## Storage

`localStorageStore()` keeps all state as JSON under the `shortcutkit.state` key; `key`, `storage`, `target` and `logger` are options, and `logger` defaults to the console. A missing value loads as empty. An unparseable value makes `load` reject, so the registry logs the error and starts from defaults.

`syncRegistry(registry, store)` from `@shortcutkit/core` follows changes from other tabs through the `storage` event, and re-reads after a back/forward cache restore (`pageshow` with `persisted`). An unparseable external value is ignored with a warning ("unparseable state"; other read failures warn "unreadable storage"). The last writer wins for the whole state.

## Platform

`detectPlatform()` returns `'mac'`, `'windows'`, `'linux'` or `'other'` from `navigator.userAgentData.platform`, falling back to `navigator.platform` and the user agent. Android reports `'other'`. Pass a navigator-like object to test it.

## Lower-level helpers

For custom hosts: `keyboardInput` and `mouseInput` turn DOM events into core inputs, `composedTarget` and `isEditingText` find the event's element and whether it edits text, and `systemLayoutMap` reads `navigator.keyboard.getLayoutMap` once.
