# @shortcutkit/core

User-rebindable keyboard and mouse shortcuts: contexts, multi-step sequences, conflict detection,
persistence with migrations and hint preferences. Pre-alpha; the API will change.

`core` uses no DOM or Node APIs; it needs only `setTimeout`, `clearTimeout` and `console` from its
environment. Hosts feed it key and mouse inputs and supply a store. `@shortcutkit/dom` provides
browser input, keyboard layout lookup and a localStorage store; the React and Tauri packages are
planned in [shortcutkit-js](https://github.com/nielsmadan/shortcutkit-js).

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

Stores that see writes from other windows implement `SyncedShortcutStore.onExternalChange`,
reporting the store's current value as `load()` would resolve it.
`syncRegistry(registry, store)` applies those writes, while unsaved local edits stay in charge.

## License

MIT
