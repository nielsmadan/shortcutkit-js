# ShortcutKit Tauri example

A Tauri app built on `@shortcutkit/tauri` and `tauri-plugin-shortcutkit`: an `editor` context (Save `Mod+S`, Find `Mod+F`, Go to Top `g g`), a global `app` context (Show Window `Ctrl+Alt+Meta+K`, which shows and focuses the `main` window) and an owner and paused indicator, an "Open settings window" button, a bindings table with a `<ShortcutRecorder>` and the global hotkey status per row, a "Reset all" button and lists of duplicate, system and menu collisions. Its shortcuts live in the plugin's state file, shared by every window of the app. Every window calls `attachGlobalHotkeys`; the first one owns the global hotkeys.

## Run

```bash
pnpm --filter @shortcutkit/example-tauri-app tauri dev
```

Run it from the repository root after `pnpm run build`, which the app reads the packages from. `tauri dev` starts Vite on <http://127.0.0.1:43173/> (`pnpm vite`) and builds the Rust crate in `src-tauri/`. Root `pnpm dev` does not start this app.

The state file is `shortcuts.json` in `~/Library/Application Support/io.quantumcraft.shortcutkit.example/` on macOS.

The window's role comes from the URL query `?role=`: `main` (default), `settings` or `smoke-peer`. The capability in `src-tauri/capabilities/default.json` covers the windows labelled `main`, `settings` and `smoke-peer`.

## Menu

The `main` window builds the app menu (shared by all windows on macOS): an app submenu with Quit, an Edit submenu of predefined items and a Shortcuts submenu whose items dispatch the editor actions. Their accelerators follow the bindings through `syncMenuAccelerators`; Go to Top (`g g`) has none. The Menu collisions list shows editor bindings that equal a predefined item's accelerator, for example Save rebound to `Mod+Q`.

## Smoke run

```bash
pnpm --filter @shortcutkit/example-tauri-app smoke
```

It runs `tauri dev --no-watch` with `SHORTCUTKIT_EXAMPLE_SMOKE=1`. The app starts hidden, without a Dock icon, and keeps its state in `results/smoke-store/`, emptied at startup. The `main` window runs each check, prints `smoke: pass <name>: <detail>` or `smoke: FAIL <name>: <detail>`, writes `results/<os>-smoke.json` and exits with 0 only when every check passed. A run that has not finished after 60 s exits with 1. The `main` window and the peer set `backgroundThrottling` to `disabled`, because WebKit stops a hidden page's timers after about 10 s and the checks' timeouts would never fire.

Checks:

- `store-roundtrip`: Save is rebound to `Mod+Shift+S` and flushed; a fresh `tauriStore().load()` returns the override.
- `store-broadcast`: a hidden `smoke-peer` window loads the state, rebinds Find to `Mod+Shift+F` and saves; `main`'s registry reports the change through `syncRegistry` within 5 s. The peer is closed afterwards.
- `global-register`: Show Window is rebound to `Ctrl+Alt+Shift+F18`; within 5 s `main` is the owner, the binding's status is `registered` and `tauri-plugin-global-shortcut` holds the shortcut. A refusal by the OS fails the check with the error as its detail.
- `global-pause`: a recorder starts; within 5 s the plugin reports `paused` and the shortcut is no longer registered. After the recorder is cancelled it is registered again. The smoke-only command `smoke_global_registered` in `src-tauri/src/lib.rs` asks `tauri-plugin-global-shortcut`.
- `menu-accelerators`: every string `toAccelerator` produces for the editor bindings parses with `muda::accelerator::Accelerator::from_str` (smoke-only command `smoke_parse_accelerator`) and `setAccelerator` resolves on the item.
- `menu-update`: Save is rebound to `Mod+Shift+K`, then to `g g`, then reset; the Save item's accelerator follows each change, the sequence clearing it, and each string parses as in `menu-accelerators`.
- `layout`: `tauriLayoutMap()` returns a non-empty map with `KeyA`; the character it maps to is reported, not checked.
- `system-shortcuts`: the system shortcut list is not empty; its size and first three entries are reported.
- `global-handover`: with a hidden `smoke-peer` window attached, `main` detaches and the peer owns the hotkeys, with the Show Window shortcut still registered; `main` attaches again behind the peer, and once the peer closes `main` owns them again.

The checks live in `src/smoke.ts`.

## Windows

WebView2's browser accelerator keys (`Ctrl+F`, `Ctrl+P`, `F5`, zoom) are on by default. On Windows the app adds `tauri-plugin-prevent-default` with no flags and `PlatformOptions::new().browser_accelerator_keys(false)`, which turns them off without blocking any key in the page.

## Manual checklist

Not covered by the smoke run; run `tauri dev` and check each item.

- A global shortcut pressed from another app: bind Show Window, hide the window, focus another app, press it, and the window shows and focuses.
- Spotlight against `Cmd+Space`: bind a global action to it and see which one fires; the System collisions list names it.
- The back and forward mouse buttons (`button` 3 and 4) record and trigger.
- CJK input: an IME composition in a text field does not trigger a shortcut or start a recording.
- Recorder in WebKit: click, Enter and Space each start recording; a key held alone commits after 1 s; a middle-click is accepted as a step; holding the key past the commit does not start another step.
- Recording a key that is currently a global hotkey: the Paused indicator reads "yes", the key reaches the recorder instead of firing the action, and the hotkey is registered again afterwards.
- Owner handover: open the settings window after `main` and check its owner indicator shows `main` as owner ("another window" in `settings`), close `main`, then press the Show Window hotkey from another app: the `settings` window comes forward and its owner indicator reads "this window".
- Windows only: WebView2 browser keys (`Ctrl+F`, `Ctrl+P`, `F5`, zoom) do nothing in the page and can be bound and recorded.
