# ShortcutKit JS

User-rebindable keyboard and mouse shortcuts for Tauri, Electron and web apps: contexts, conflict
detection, persistence with migrations, a settings UI, a legend and discoverability hints.

A port of the Swift packages [ShortcutKit](https://github.com/nielsmadan/ShortcutKit) and
[ShortcutField](https://github.com/nielsmadan/ShortcutField). Pre-alpha: nothing is published yet.
See [`docs/plan.md`](docs/plan.md).

## Packages

- [`@shortcutkit/core`](packages/core): the framework-neutral registry, grammar, matcher, conflicts
  and persistence.
- [`@shortcutkit/dom`](packages/dom): browser keyboard and mouse input, a shortcut recorder,
  text-input and IME gating, keyboard layout and a localStorage store with tab sync.
- [`@shortcutkit/react`](packages/react): `ShortcutKitProvider`, hooks for the registry, key
  bindings, labels and context activation, and a `<ShortcutRecorder>` field.
- [`@shortcutkit/tauri` and `tauri-plugin-shortcutkit`](packages/tauri): a state file shared by
  every window, global hotkeys, menu accelerator sync, keyboard layout and macOS system shortcuts.

## Development

```bash
pnpm run setup
pnpm dev          # build, watch the packages and serve the playgrounds at http://127.0.0.1:43171/ (plain web) and :43172 (React)
pnpm run check-all
pnpm test
```

## License

MIT. Parts of `@shortcutkit/dom` are adapted from
[TanStack Hotkeys](https://github.com/TanStack/hotkeys) (MIT); see
[`packages/dom/THIRD_PARTY_NOTICES.md`](packages/dom/THIRD_PARTY_NOTICES.md). The key-code table
in `tauri-plugin-shortcutkit` is adapted from Chromium (BSD-3-Clause); see
[`packages/tauri/THIRD_PARTY_NOTICES.md`](packages/tauri/THIRD_PARTY_NOTICES.md).
