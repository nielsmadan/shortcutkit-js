# Repository Guidelines

This is the single source of truth for agentic coding instructions. Coding agents read this file directly.

## Project

ShortcutKit for JavaScript: user-rebindable keyboard and mouse shortcuts with contexts, conflict
detection, persistence with migrations, a settings UI, a legend and hints, for Tauri first and
Electron and plain web later. It is a port of the Swift packages
[ShortcutKit](https://github.com/nielsmadan/ShortcutKit) and
[ShortcutField](https://github.com/nielsmadan/ShortcutField). The Swift code and its tests are the
behavioural spec; port behaviour, not AppKit mechanics.

Status: pre-alpha. The plan, the decisions behind it and the open questions are in
[`docs/plan.md`](docs/plan.md).

## Layout

- `packages/`: `@shortcutkit/*` packages, each built by its own `tsdown.config.ts`. `core` has
  Vitest suites ported from the Swift tests; `dom`'s suites run under happy-dom (each test file
  starts with `// @vitest-environment happy-dom`). Planned: `react`, `tauri`, plus the Rust crate
  `tauri-plugin-shortcutkit`. Shared tooling is a root devDependency.
- `examples/`: the plain-web playground (`examples/playground`), served by `pnpm dev`.
- `spikes/`: throwaway experiments that answer a design question. Record each spike's findings in
  `docs/` before deleting it.

## Commands

pnpm workspace; Node 24+.

```bash
pnpm run setup          # install locked dependencies, build, install Git hooks, run doctor
pnpm dev                # build, then watch the packages and serve the playground on :43171
pnpm run doctor         # verify dependencies and hook installation
pnpm run build          # bundle every package with tsdown into its dist/
pnpm run check-package  # build, pack, publint, attw, then type-check and run the README example
pnpm run check-all      # format check, lint, check-package, type-check
pnpm test               # tests in every package
pnpm run format         # format with Prettier
```

Packages resolve each other through `dist/`, so rebuild after changing a package another one
imports: `type-check` and `test` run on their own read the last build (`check-all` builds first).
Publish with `pnpm --filter @shortcutkit/<name> publish`, core and dom at the same version;
`prepublishOnly` runs type-check, tests and `check-package`. A bare `pnpm pack` does not build.

The input spike: `pnpm --filter @shortcutkit/spike-tauri-input tauri dev`, see its README.

## Design rules

- `core` has no DOM, no Node and no host APIs; it runs in plain Node tests. Hosts plug in through
  interfaces (store, keyboard layout, global hotkeys, menus). It uses only `setTimeout`,
  `clearTimeout` and `console`, declared in `src/globals.d.ts`; those types must stay out of
  exported signatures, which `check-package` catches.
- Packages ship ESM only, ES2023, with `sideEffects: false`. Mark module-level tables built by
  calls `/* @__PURE__ */` so unused ones tree-shake.
- Optional input properties are typed `?: T | undefined`, so consumers with
  `exactOptionalPropertyTypes` can forward possibly-undefined values.
- `ShortcutRegistry` is exported as a type only; adopters construct it with `createRegistry`,
  which loads the store first. Tests import the class from `src/registry`.
- Framework adapters stay thin: state lives in framework-neutral stores exposed as
  `subscribe`/`getSnapshot`, so React is the first adapter, not the only one.
- Key identity is `KeyboardEvent.code`. No macOS key codes and no compatibility with the Swift
  version's config files.
- Gestures (scroll, pinch, rotate, continuous shortcuts) are deferred, but types leave room for
  them; mouse buttons are in scope.
- `dom` reads `window`, `navigator` and `localStorage` only when its functions run, with each
  injectable through options, and warns through core's `Logger`.
- Consuming an input means `preventDefault` plus `stopPropagation`; already-prevented events are
  skipped, and a consumed press's follow-up mouse events are consumed too. See "DOM input" in
  `docs/plan.md`.
- Stores that see other windows' writes implement `onExternalChange`, and `syncRegistry` applies
  them. A store reports the value it holds now, unless its events are guaranteed to arrive in
  write order.

## Commit messages

Use `feat:`, `fix:` or `chore:` with no scope, a single short clause, and no body unless asked.
