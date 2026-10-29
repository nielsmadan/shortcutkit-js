# Port plan

## Decisions

| Topic         | Decision                                                                                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosts         | Tauri first. Electron and plain web must remain possible through the host interfaces, without changes to `core`.                                                                                                                                                 |
| Config        | No compatibility with the Swift version's files. Key identity is `KeyboardEvent.code`; the text grammar is free to change.                                                                                                                                       |
| Persistence   | v1 stores a JSON file in the app config directory, written atomically by the Tauri backend. Lossless TOML is deferred.                                                                                                                                           |
| Input kinds   | Keys and mouse buttons in v1. Scroll, pinch, rotate, smart magnify and continuous shortcuts are deferred; types keep room.                                                                                                                                       |
| UI            | React first. State lives in framework-neutral stores so other adapters only add bindings and components.                                                                                                                                                         |
| Swift version | Ported from a pinned commit while its 1.0 review runs; review fixes are carried over.                                                                                                                                                                            |
| Packaging     | tsdown bundles each package to `dist/`, ESM only, ES2023. Workspace packages resolve each other through `dist/`; `pnpm dev` builds once, then runs `tsdown --watch --no-clean` per package beside the playground's Vite server, which reloads on `dist` changes. |

## Packages

| Package                                           | Contents                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shortcutkit/core`                               | Model, text grammar, sequence matcher, registry, contexts, conflicts, migrations, hint policy, filter, debug events, host interfaces                     |
| `@shortcutkit/dom`                                | Keyboard and mouse event source, text-input and IME gate, platform detection, `getLayoutMap` provider with US fallback, localStorage store with tab sync |
| `@shortcutkit/react`                              | Hooks, recorder, settings view, legend, in-window hint display                                                                                           |
| `@shortcutkit/tauri` + `tauri-plugin-shortcutkit` | Store and broadcast, global hotkeys, menu accelerator sync, keyboard layout lookup, macOS system shortcuts                                               |

Host interfaces in `core`: store (async `load`/`save` of the raw state), keyboard layout function
(`KeyboardLayoutMap.get`-compatible), system shortcuts provider, menu shortcuts for collision
checks. The global hotkey backend reads `globalBindings()` and calls `dispatchGlobal()`. A store
that sees other windows' writes also implements `onExternalChange` (`SyncedShortcutStore`).

## Core design

- Contexts are plain declarations (`defineContext`); the registry is the runtime. Action ids are the
  keys of the `actions` object, typed through to `activate`, `dispatch` and `setShortcuts`.
- Shortcuts are `{ steps: [{ input: { type: 'key', code } | { type: 'mouse', button }, modifiers }] }`.
  The text grammar is `mod+shift+k left-click`: modifiers `ctrl`, `alt`, `shift`, `meta` and the
  parse-only `mod`; keys are `KeyboardEvent.code` tokens; mouse buttons use web numbering.
- Defaults are strings resolved per platform at registry construction; overrides persist as
  canonical strings, so `RawState` is plain JSON and custom migrations edit strings.
- `createRegistry` is the only public constructor: it loads the store before the registry can
  save, so an unloaded registry never overwrites persisted overrides.
- The store is async. `load()` runs migrations best-effort and writes back. `reload()` flushes,
  loads, migrates strictly and reports `stale` if a local edit landed meanwhile. `applyState()`
  takes state pushed from another window and refuses it while local edits are unsaved. These
  replace Swift's `prepare`/`commit`.
- State is exposed as `subscribe`/`getSnapshot` (bindings, conflicts, hint preferences,
  activations); events are `onActionFired`, `onSaveResult` and `onDebugEvent`. Debug events are
  built only while a listener is attached.
- The host feeds key and mouse inputs to `handleInput()` (key inputs carry `code`, `repeat` and
  `editingText`) and consumes the event on `advanced` or `fired`. Unlike AppKit, every
  intermediate sequence step is consumed. Modifier keydowns are ignored without resetting a
  sequence.
- The step timeout and save debounce use `setTimeout`, so core needs no DOM or Node APIs.

## Multi-window model

The Rust plugin owns the file: it reads, writes atomically and broadcasts each save to every window.
Each window runs its own registry and matcher. Migrations are declared in JS, so the first registry
to load migrates and writes back. Edits are saved through the store; each broadcast goes to
`applyState()`, which ignores it while that window has unsaved edits of its own. Single-window apps
take the same path.

`syncRegistry(registry, store)` is that wiring for any `SyncedShortcutStore`. It skips a state equal
to the registry's own (applying one would reset a sequence in progress), applies the rest, and on a
refusal flushes, so a save that failed earlier is retried and the local edit supersedes. The
localStorage store (`@shortcutkit/dom`) reports what storage holds now: it re-reads its key on
every `storage` event and on a back/forward cache restore instead of trusting `event.newValue`,
because a late event carries an outdated value and tabs would otherwise diverge. A store may report
an event's payload only when its events arrive in write order. Last writer wins for the whole
state.

Open for async stores (step 4): a write from another window that lands while a save is in flight,
or between `load()` and subscribing, is never reported, so that window stays stale until its next
save. The Tauri store needs revisions, or a re-read after each save and after subscribing.

## Order

1. Input spike in Tauri (`spikes/tauri-input`).
2. `core`, with the Swift test suites (minus TOML persistence) ported to Vitest as the spec.
3. `dom`, React hooks and the recorder, against a plain-web playground with a localStorage store.
   `dom` and the playground (`examples/playground`) are done. The recorder must pause matching
   while it records: an earlier `window` capture listener that calls `preventDefault` claims
   events, since `attachInput` skips prevented ones, but a recorder that mounts after
   `attachInput` runs too late, so part 2 adds a pause hook.
4. The Rust plugin and an example Tauri app.
5. Settings view, legend and hint display.

## DOM input

- One set of capture-phase listeners on `window`. Events already `defaultPrevented` are skipped.
  Consuming means `preventDefault` plus `stopPropagation` (`stopPropagation: false` opts out),
  matching Swift, which drops a consumed event.
- A consumed `mousedown` also consumes the rest of that press (`mouseup`, `click`, `auxclick`,
  `dblclick`, `contextmenu`), because browsers fire those after a prevented `mousedown`. The arm is
  one flag, cleared by the next `pointerdown` or `mousedown` and by a non-repeat, non-modifier
  `keydown`, even ones another listener claimed. Held modifiers auto-repeat during a
  modifier+click, so they must not disarm.
- A handler that throws still consumes its event; the error is rethrown asynchronously. Core
  isolates observer listeners (`subscribe`, `onDebugEvent`, …) the same way, so a throwing logger
  cannot turn every keystroke into a consumed one.
- `editingText` covers `textarea`, text-like `input` types (by IDL `type`) and
  `isContentEditable`, minus readonly and disabled fields, resolved through
  `composedPath()[0]` for open shadow roots. Keydowns with `isComposing` or `keyCode === 229`
  never reach the registry.
- The layout provider calls `navigator.keyboard.getLayoutMap()` as a method (a detached call
  throws in Chromium), refreshes on window focus while subscribed, keeps the last good layout on
  failure and falls back to `usLayout`. No learned map.
- dom touches `window`, `navigator` and `localStorage` only when its functions run, and warns
  through core's `Logger`.

Open: AltGr reports Ctrl+Alt on Windows and Linux, so `ctrl+alt+<key>` bindings fire while typing
AltGr characters; `keyup` and pointer events of a consumed input still reach the page; a script's
`element.click()` during an armed press is consumed.

## Tauri findings

Confirmed by the spike's automatic run (macOS 26, Tauri 2.12.4, WKWebView):

- `navigator.keyboard` is absent, so `getLayoutMap()` is unavailable. Layout-aware labels need a
  native lookup from the plugin (port of the Swift `UCKeyTranslate` code) or a learned map.
- An app menu built from JS with accelerators installs fine.
- `register('CommandOrControl+Space')` succeeds and `isRegistered` returns true although Spotlight
  owns that shortcut. Registration success does not mean the shortcut will fire, so the
  system-shortcut conflict check stays necessary.
- An unparseable accelerator rejects with muda's parser message, e.g.
  `Couldn't recognize "Hyper" as a valid key for hotkey`.

Confirmed by the spike's manual steps on macOS:

- No alert sound for unhandled keys, with or without `preventDefault`, in the page or in a text
  field (`⌘1` included). The beep feared in [wry#799](https://github.com/tauri-apps/wry/issues/799)
  does not occur.
- A menu accelerator reaches the page first: the capture-phase `keydown` fires, then the menu item
  about 4 ms later, in the page and in text fields alike. Calling `preventDefault` on that `keydown`
  stops the menu item (checked with focus outside text fields). So in-page shortcuts and menu
  accelerators for the same key can be arbitrated in JS.
- `MenuItem.setAccelerator` rebinds at runtime: the new combo fires the item, the old one no
  longer does.
- Dead keys (Option+E, then E) emit `compositionstart`, a `keydown` with `key: 'Dead'`,
  `isComposing: true` and `keyCode: 229`, then `compositionend` with `'é'` and a final `keydown`
  with `key: 'é'`, `keyCode: 229` but `isComposing: false`. The IME gate must check
  `keyCode === 229` as well as `isComposing`. Same shape in input, textarea and contenteditable.
- Mouse: middle button is `button: 1` (`buttons: 4`) with `mousedown` and `auxclick`; right button
  is `button: 2` with `contextmenu`.
- Trackpad pinch fires both WebKit `gesturestart`/`gestureend` (with `scale`, `rotation`) and
  `wheel` events with `ctrlKey`; rotate fires only the gesture events.
- Juggler's Carbon global hotkeys (⌘⇧K and others) swallow the key before the webview sees it;
  the spike was moved off them.

Still open on macOS:

- Global shortcuts firing from another app, and whether Spotlight still wins `⌘Space` after
  registering it. Carbon matches modifiers exactly, so a Hyper key press (⌃⌥⇧⌘) does not trigger
  a ⌘⌥⇧ registration.
- Back and forward mouse buttons (`button: 3`/`4`).
- CJK input methods.

Open on other platforms (the spike runs there too):

- Windows: WebView2 browser keys (Ctrl+F, Ctrl+P, F5, zoom) are on by default. wry has
  `with_browser_accelerator_keys(false)`; Tauri's config and runtime do not expose it, so it needs
  `tauri-plugin-prevent-default` or webview settings access.
- Linux: global shortcuts work on X11 only. WebKitGTK also lacks `getLayoutMap`.
