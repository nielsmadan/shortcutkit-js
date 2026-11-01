# @shortcutkit/core

User-rebindable keyboard and mouse shortcuts: contexts, multi-step sequences, conflict detection,
persistence with migrations and hint preferences. Pre-alpha; the API will change.

`core` uses no DOM or Node APIs; it needs only `setTimeout`, `clearTimeout` and `console` from its
environment. Hosts feed it key and mouse inputs and supply a store. `@shortcutkit/dom` provides
browser input, keyboard layout lookup and a localStorage store, and `@shortcutkit/react` provides
React hooks; a Tauri package is planned in
[shortcutkit-js](https://github.com/nielsmadan/shortcutkit-js).

```bash
pnpm add @shortcutkit/core
```

ESM only, ES2023.

```ts
import { createRegistry, defineContext, memoryStore, modifiers } from '@shortcutkit/core';

const editor = defineContext({
  id: 'editor',
  actions: {
    save: { displayName: 'Save', defaults: 'mod+s' },
    comment: { displayName: 'Comment Line', defaults: 'mod+k mod+c' },
  },
});

const registry = await createRegistry({
  contexts: [editor],
  platform: 'mac',
  store: memoryStore(),
});
registry.activate(editor, (action) => console.log(action));

registry.handleInput({ type: 'key', code: 'KeyS', modifiers: modifiers(['meta']) });
```

`handleInput` returns `'fired'`, `'advanced'` or `'ignored'`; consume the event unless it is
`'ignored'`.

`registry.suspend()` pauses matching, for example while a shortcut is being recorded: `handleInput`
returns `'ignored'` until the returned release function is called, and sequences in progress are
reset. Pass a filter to ignore only the inputs for which it returns `true`; a filtered suspension
resets nothing. `dispatch` is unaffected. `registry.isSuspended` is `true` while an unfiltered
suspension is held. `onDebugEvent` listeners receive each ignored input with the outcome `{ type: 'suspended' }`.
`registry.stepTimeoutMs` is the time allowed between the steps of a sequence.
`registry.refreshConflicts()` re-reads the `systemShortcuts` option and republishes the snapshot with recomputed conflicts.

`unsupportedInScope(shortcut, scope)` returns why a shortcut cannot be bound in a context of that
scope (`'multiStepInGlobal'` or `'mouseInGlobal'`), or `undefined`; `describeUnsupported(reason)`
returns an English message for it.

Stores that see writes from other windows implement `SyncedShortcutStore.onExternalChange`,
reporting the store's current value as `load()` would resolve it.
`syncRegistry(registry, store)` applies those writes, while unsaved local edits stay in charge.

## License

MIT
