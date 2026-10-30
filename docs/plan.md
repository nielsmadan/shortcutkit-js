# Port plan

## Decisions

| Topic         | Decision                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosts         | Tauri first. Electron and plain web must remain possible through the host interfaces, without changes to `core`.                                                                                                                                                  |
| Config        | No compatibility with the Swift version's files. Key identity is `KeyboardEvent.code`; the text grammar is free to change.                                                                                                                                        |
| Persistence   | v1 stores a JSON file in the app config directory, written atomically by the Tauri backend. Lossless TOML is deferred.                                                                                                                                            |
| Input kinds   | Keys and mouse buttons in v1. Scroll, pinch, rotate, smart magnify and continuous shortcuts are deferred; types keep room.                                                                                                                                        |
| UI            | React first. State lives in framework-neutral stores so other adapters only add bindings and components.                                                                                                                                                          |
| Swift version | Ported from a pinned commit while its 1.0 review runs; review fixes are carried over.                                                                                                                                                                             |
| Packaging     | tsdown bundles each package to `dist/`, ESM only, ES2023. Workspace packages resolve each other through `dist/`; `pnpm dev` builds once, then runs `tsdown --watch --no-clean` per package beside each playground's Vite server, which reloads on `dist` changes. |

## Packages

| Package                                           | Contents                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@shortcutkit/core`                               | Model, text grammar, sequence matcher, registry, contexts, conflicts, migrations, hint policy, filter, debug events, matching pause, host interfaces                                                    |
| `@shortcutkit/dom`                                | Keyboard and mouse event source, text-input and IME gate, shortcut recorder with its post-session guard, platform detection, `getLayoutMap` provider with US fallback, localStorage store with tab sync |
| `@shortcutkit/react`                              | Provider, hooks, recorder hook and `<ShortcutRecorder>`; planned: settings view, legend, in-window hint display                                                                                         |
| `@shortcutkit/tauri` + `tauri-plugin-shortcutkit` | Store and broadcast, global hotkeys, menu accelerator sync, keyboard layout lookup, macOS system shortcuts                                                                                              |

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
- `suspend(filter?)` pauses matching and returns an idempotent release; suspensions stack. While
  an unfiltered one is held, `handleInput` returns `ignored` for every input, and taking the first
  one resets every activation's sequence in progress, so a `g` typed before a recording cannot
  complete `g g` after it. A filtered suspension ignores only the inputs its filter returns `true`
  for and resets nothing, so the recorder's post-session guard can take one without cancelling a
  sequence the user has started. A release resets nothing. Ignored inputs emit the debug outcome
  `{ type: 'suspended' }`. `dispatch` and `dispatchGlobal` are unaffected, as Swift pauses only
  its event dispatcher. `isSuspended` reports unfiltered suspensions only. A throwing filter
  propagates out of `handleInput`; the only filter is dom's own.
- `stepTimeoutMs` is public so the recorder can default its idle timeout to it.
  `unsupportedInScope` and `describeUnsupported` are exported for the recorder's global-scope rule
  and share the check with conflict detection; the messages are English, so a UI needing other
  text maps the reason itself.

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
   Done: `dom`, the matching pause, the recorder, `@shortcutkit/react` and both playgrounds
   (`examples/playground`, `examples/react-playground`). The recorder pauses matching through
   `registry.suspend()` rather than claiming events first, because a recorder that mounts after
   `attachInput` registers its listeners too late to run before it.
4. The Rust plugin and an example Tauri app.
5. Settings view, legend and hint display.

## DOM input

- `attachInput` adds one set of capture-phase listeners on `window`. Events already
  `defaultPrevented` are skipped.
  Consuming means `preventDefault` plus `stopPropagation` (`stopPropagation: false` opts out),
  matching Swift, which drops a consumed event.
- A consumed `mousedown` also consumes the rest of that press (`mouseup`, `click`, `auxclick`,
  `dblclick`, `contextmenu`), because browsers fire those after a prevented `mousedown`. The arm is
  one flag, cleared by the next `pointerdown` or `mousedown` and by a non-repeat, non-modifier
  `keydown`, even ones another listener claimed. Held modifiers auto-repeat during a
  modifier+click, so they must not disarm. The arm and its listeners live in one helper
  (`packages/dom/src/press.ts`) shared by `attachInput`, the recorder session and the
  post-session guard, so the rule changes in one place for all three.
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
AltGr characters; `keyup` and pointer events of an input `attachInput` consumed still reach the
page; a script's `element.click()` during an armed press is consumed.

## Recorder

`createShortcutRecorder` in `dom` holds all recording logic behind `subscribe`/`getSnapshot`;
React only renders it. Swift ShortcutField is the behavioural spec, with these deviations:

- Focus alone never starts recording; a click, Enter or Space on the field does.
- Focus stays on the field after a session. Swift blurs it, which on the web drops keyboard users
  at `<body>`.
- `<ShortcutRecorder>` hides × once a step is recorded; Swift shows it for the whole recording.
  Pressing × mid-recording is a mousedown outside the field, which finalizes and commits the steps
  before the clear runs, so the user would see the recording saved and then wiped.
- A rejection caption also goes away on a clear or a new `value`, not only on the next accepted
  commit, since it is stale once the value it argued about changed. The controller's
  `dismissRejection()` does this, so custom fields built on the hook get the same path; in
  `<ShortcutRecorder>` it runs in an effect, so the caption outlives a new value by one effect
  flush. After a dismissal the next AltGr character is reported again.

Session rules:

- `start()` takes an unfiltered `registry.suspend()`, cancels any other recorder of the same
  registry (its `onCancel` runs) and focuses the field without scrolling.
- Capture-phase listeners on `window` (or the `target` option) consume every key press, Tab and
  Enter included; IME keydowns are left to the page. Non-modifier keys and mouse presses other
  than a bare left-click become steps; repeats, modifier keys (CapsLock and NumLock count as
  modifiers) and codes `isBindableKeyCode` rejects record nothing. Bare Escape cancels; bare Backspace or Delete before the first step clears;
  modified ones are steps.
- A session finalizes on the idle timeout (default `stepTimeoutMs`), a bare left-click (consumed
  with its press inside the field, passed through outside it), focus leaving the field, window
  blur, a hidden page or `pagehide`. No steps is a cancel. A `validate` message or throw is a
  rejection with no commit.
- Ending tears the session down, releases the suspension, starts the guard and publishes before
  it runs the callback, so a callback may start another recorder, call `setShortcuts` or throw.
- Window blur is detected by a bubble-phase listener on the window checking
  `eventPhase === AT_TARGET`; happy-dom's window blur does not have the window as its target.
- The active-recorder slot and `recordingStatus` are kept per registry in a module-level
  `WeakMap` in `dom`. Preemption and `useIsRecording` therefore need one copy of `@shortcutkit/dom`
  per app; a second copy sees only its own recorders.
- Inside a shadow root, `relatedTarget` is retargeted to the host, so focus moving between
  descendants of a multi-element recorder finalizes. Every shipped recorder is a single button.

Post-session guard: keys still held when a session ends would auto-repeat into the registry once
the suspension is lifted and fire the shortcut just recorded. Each ended session hands its held
codes and armed press to a guard that no recorder owns, so `destroy()` and unmounting do not cut
it short. The guard takes a filtered suspension that ignores only repeat keydowns of held codes,
so fresh presses still match; consumes the held codes' `keyup`s; unmarks a code on a fresh press
of it; and consumes the armed press's follow-ups by the shared press rule. A modifier `keyup`
clears every held code, because macOS drops the main key's `keyup` while Command is held. The
guard ends when nothing is held or armed, on window blur, on a hidden page or on `pagehide`.
Modifiers and lock keys are never held.

Global scope: with `scope="global"`, the recorder rejects multi-step and mouse shortcuts (Swift
`ScopePolicy`) through core's `unsupportedInScope`, before the adopter's `validate`, and shows the
`describeUnsupported` text as the caption. Clashes with other actions are not rejected while
recording; they appear in the registry's conflicts after saving.

AltGr: off macOS, a keydown with `getModifierState('AltGraph')` is rejected with
`{ reason: 'altGraph' }` instead of being recorded as Ctrl+Alt, which would fire while typing that
character. The exception is Windows, where AltGr on a key that types nothing new (AltGr+Home)
records as `ctrl+alt`. On macOS AltGraph is ignored, because WebKit reports it for Option on some layouts,
where Option is a plain Alt. Matching in `attachInput` is unchanged (see "Open" above).

## React adapter

- Peer range `^18.0.0 || ^19.0.0`, with no React-19-only APIs (`use`, `useEffectEvent`, `ref` as a
  prop on function components). Development and tests use React 19, every test inside
  `<StrictMode>`.
- Every store is read with `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)`; the third
  argument makes server rendering work.
- Latest handlers and options live in refs updated in `useInsertionEffect`. Assigning during
  render is rejected by `react-hooks/refs`, and `useLayoutEffect` warns during React 18 server
  rendering; `useInsertionEffect` runs before layout effects in both versions and is silent on
  the server.
- The recorder controller is memoized on the registry, so a provider registry swap rebinds
  mounted recorders. Construction has no side effects and `destroy()` only cancels, so
  StrictMode's unmount and remount, or a discarded memo, cost at most a cancelled recording.
- The provider re-attaches input only when the registry, `target` or `stopPropagation` changes.
- The recorder always listens on `window`, not the provider's `input.target`: a recorder in a
  portal outside that target would otherwise record nothing while the registry stayed suspended,
  and a window capture listener still runs before an `attachInput` on an element. Scoping input
  to an iframe's window would need a target option on the hook.
- Effects run children first, so when a parent and a child activate in the same commit the parent
  is innermost and wins ties.
- `useFocusShortcutContext` keeps a `focused` state and passes it to `useShortcutContext` as
  `enabled`, so a registry or context change while focused re-activates through the one path.
  React flushes effects of discrete events synchronously, so a key pressed right after focus
  matches. A focus-scoped context stays active when its focused descendant is removed from the
  DOM: Firefox and WebKit fire no blur, and React delivers no `onBlur` for a node it deletes. It
  stays active until focus enters the element and leaves it again; detecting the removal needs a
  `MutationObserver` or an `activeElement` check.

## Third-party code

TanStack Hotkeys (MIT) is not a dependency. Re-implement what is simple after reading it; copy
code only where it is hard to get right or full of gotchas, and adapt it to this repo's
conventions. Credit each such file with the first line
`// Portions adapted from TanStack Hotkeys (MIT); see THIRD_PARTY_NOTICES.md`, and list it, with
the upstream file it derives from, in that package's `THIRD_PARTY_NOTICES.md`, which carries the
full MIT text and copyright line and is in the package's `files`. Ideas alone need no notice. In
`dom`, `recording-guard.ts` and `altgraph.ts` are adapted.

## Deferred and unverified

- The binding editor row and the settings view (step 5).
- A one-off `useShortcut` outside the registry, like Swift's `.onShortcut`.
- Scroll and gesture recording.
- `suspend()` does not cover `dispatchGlobal` and has no change notification, so OS-level global
  hotkeys keep firing while recording. The Tauri adapter (step 4) needs a way to pause them.
- No React 18 smoke test has run; the hooks avoid React-19-only APIs, but a React 18 bug would
  surface only in an adopter's app.
- No WebKit QA of the recorder: click, Enter and Space start, a key committing after the timeout,
  a middle-click step, and held-key repeats after a commit.
- AltGr has not been checked on a real Windows or Linux keyboard; recording AltGr+Q should show
  the AltGr caption.

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
