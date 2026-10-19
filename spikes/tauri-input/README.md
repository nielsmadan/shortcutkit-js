# Tauri input spike

A throwaway Tauri app that answers how keyboard, mouse, menu and global-shortcut input behaves in
Tauri's webviews. Findings go to [`docs/plan.md`](../../docs/plan.md).

## Run

```bash
pnpm --filter @shortcutkit/spike-tauri-input tauri dev
```

Follow the numbered steps in the window. The page logs every key, mouse, composition, menu and
global-shortcut event, and saves the log and your answers to `results/<os>-manual.json` a moment
after each event. Avoid ⌘Q and ⌘W while testing.

`pnpm --filter @shortcutkit/spike-tauri-input smoke` runs only the automatic checks in a hidden
window, writes `results/<os>-smoke.json` and exits.

## What it checks

- Automatic: `navigator.keyboard.getLayoutMap`, building an app menu from JS, global-shortcut
  registration of a free combo, of ⌘Space, and of an invalid accelerator.
- Manual: the macOS alert sound with and without `preventDefault`, menu accelerators against the
  page, `MenuItem.setAccelerator` at runtime, text fields with dead keys and IME, mouse buttons,
  trackpad gestures, and global shortcuts from another app. On Windows, WebView2 browser keys.
