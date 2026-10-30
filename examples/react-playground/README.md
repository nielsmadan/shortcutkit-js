# ShortcutKit React playground

The plain-web playground rebuilt with `@shortcutkit/react`: the same three contexts, keyboard and mouse shortcuts, persistence and live event log, with a `<ShortcutRecorder>` in each row of the bindings table instead of a text form.

```bash
pnpm dev
```

Run it from the repository root, then open <http://127.0.0.1:43172/>. The plain-web playground is served beside it at <http://127.0.0.1:43171/>. Both build the packages once and then watch them, so edits under `packages/*/src` reload the page.

## Platform override

Add `?platform=mac`, `windows`, `linux` or `other` to the URL, or use `#platform-override`.

## Recording

Click a field in the bindings table (or focus it and press Enter or Space) and type a shortcut. It edits the action's first shortcut; `×` clears it, and the `Reset` button appears once an action is customized.

## Two-tab sync

Open the page in two tabs, record a shortcut in one and watch `#bindings` and `#stored-state` update in the other. The log shows `sync applied`.

## Element ids

Same as the plain-web playground where the element exists:

- Status: `#platform`, `#platform-override`, `#layout-source`, `#active-contexts`.
- List: `#list-section`, `#list-items`, `#list-selection`.
- Editor: `#editor-section`, `#editor-title`, `#editor-body`, `#editor-status`.
- Mouse: `#mouse-section`, `#click-target`, `#click-count`, `#nav-status`, `#mouse-status`.
- Overlays: `#help`, `#palette`.
- Bindings: `table#bindings`, rows `tr#binding-<ctx>-<action>` with `button#recorder-<ctx>-<action>` (the field) and, when customized, `button#reset-<ctx>-<action>`; `#recording-indicator`, `button#reset-all`, `button#reload-store`.
- Log: `input#debug-toggle`, `button#clear-log`, `ol#log`.
- Persistence: `pre#stored-state`, `#save-status`.

`document.body.dataset.ready` is `'true'` once the registry is created and the first render is scheduled.
