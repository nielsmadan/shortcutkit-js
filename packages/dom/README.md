# @shortcutkit/dom

Browser input for `@shortcutkit/core`: keyboard and mouse listeners, a shortcut recorder, text-input and IME gating, keyboard layout lookup and localStorage persistence. Pre-alpha; the API will change.

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

## Recorder

`createShortcutRecorder(registry, options)` records a shortcut from the user's next keys and mouse buttons. It is framework-neutral: `subscribe` and `getSnapshot` expose `{ recording, steps, rejection }`, and `getSnapshot` returns the same object until the state changes. Creating a recorder has no side effects; `start()` begins a session, `cancel()` ends it, `setOptions(options)` replaces the options (read when each event arrives), `dismissRejection()` sets `rejection` to `undefined`, and `destroy()` cancels a session in progress and leaves the recorder usable.

```js
const recorder = createShortcutRecorder(registry, {
  element: button,
  onCommit: (shortcut) => registry.setShortcuts(editor, 'save', [shortcut]),
  onClear: () => registry.setShortcuts(editor, 'save', []),
});
button.addEventListener('click', () => recorder.start());
```

While recording:

- The registry is suspended (`registry.suspend()`), so bound shortcuts do not fire, and starting a recorder cancels any other recorder of the same registry. `recordingStatus(registry)` is a `subscribe`/`getSnapshot` store that is true while one records.
- Capture-phase listeners on `window` (or `options.target`) consume every key press, Tab and Enter included. Each non-modifier key press, and each mouse press other than a bare left-click, becomes a step; key repeats, modifier-only presses and keys `isBindableKeyCode` rejects are consumed and record nothing. Keydowns during IME composition are left to the page.
- Bare Escape cancels. Bare Backspace or Delete before the first step clears (`onClear`); after a step it is recorded.
- The recording finalizes after `idleTimeoutMs` without a new step (default: the registry's `stepTimeoutMs`), on a bare left-click, when focus leaves `options.element`, on window blur, or when the page is hidden. A bare left-click inside `element` is consumed with the rest of its press; one outside it reaches the page. Finalizing with no steps is a cancel.
- `start()` focuses `element` without scrolling.

`validate(shortcut)` returns a message to reject the shortcut. A rejection ends the session without calling `onCommit` and sets `rejection` to `{ reason: 'invalid', message, shortcut }`; a validator that throws does the same with the error's message and rethrows asynchronously. On Windows and Linux a key typed with AltGr sets `rejection` to `{ reason: 'altGraph' }` and is not recorded; AltGr on a key that types nothing new records as Ctrl+Alt on Windows. A rejection stays until the next commit or clear, or until `dismissRejection()`, after which the next AltGr character is reported again.

When a session ends, keys still held stay guarded: their repeats are consumed and cannot fire the shortcut just recorded, and their `keyup`s are consumed, until each is released, a modifier is released, the window blurs or the page is hidden. The follow-up events of a consumed mouse press are consumed until the next press or non-modifier key. Callbacks run after the session has ended, so one may start another recorder or change shortcuts; a throwing callback is rethrown asynchronously.

## Keyboard layout

`keyboardLayoutProvider()` returns a provider with `subscribe`, `getSnapshot` and `refresh`. The first lookup starts on the first `subscribe` or `refresh()`, so read `getSnapshot()` from a subscriber. The snapshot is the US layout until a lookup succeeds; pass `provider.getSnapshot()` as `layout` to core's label functions, such as `shortcutLabel` and `stepLabel`. The lookup uses `navigator.keyboard.getLayoutMap`, which is Chromium-only and needs a secure context; elsewhere the US layout stays. The layout refreshes on window focus while someone is subscribed, and a failed lookup warns once through the `logger` option, which defaults to the console. A host can pass its own `load` to supply the map.

## Storage

`localStorageStore()` keeps all state as JSON under the `shortcutkit.state` key; `key`, `storage`, `target` and `logger` are options, and `logger` defaults to the console. A missing value loads as empty. An unparseable value makes `load` reject, so the registry logs the error and starts from defaults.

`syncRegistry(registry, store)` from `@shortcutkit/core` follows changes from other tabs through the `storage` event, and re-reads after a back/forward cache restore (`pageshow` with `persisted`). An unparseable external value is ignored with a warning ("unparseable state"; other read failures warn "unreadable storage"). The last writer wins for the whole state.

## Platform

`detectPlatform()` returns `'mac'`, `'windows'`, `'linux'` or `'other'` from `navigator.userAgentData.platform`, falling back to `navigator.platform` and the user agent. Android reports `'other'`. Pass a navigator-like object to test it.

## Lower-level helpers

For custom hosts: `keyboardInput` and `mouseInput` turn DOM events into core inputs, `composedTarget` and `isEditingText` find the event's element and whether it edits text, and `systemLayoutMap` reads `navigator.keyboard.getLayoutMap` once.
