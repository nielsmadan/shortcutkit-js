# ShortcutKit playground

A browser page that exercises `@shortcutkit/core` and `@shortcutkit/dom`: keyboard and mouse shortcuts in three contexts, rebinding, conflicts, persistence and a live event log.

```bash
pnpm dev
```

Run it from the repository root, then open <http://127.0.0.1:43171/>. It builds both packages once and then watches them, so edits under `packages/*/src` reload the page.

## Platform override

The platform is detected from the browser. Add `?platform=mac`, `windows`, `linux` or `other` to the URL, or use `#platform-override`, to pretend otherwise.

## Two-tab sync

Open the page in two tabs, rebind an action in one and watch `#bindings` and `#stored-state` update in the other. The log shows `sync applied`.

## Element ids

- Status: `#platform`, `#platform-override`, `#layout-source`, `#active-contexts`.
- List: `#list-section`, `#list-items`, `#list-selection`.
- Editor: `#editor-section`, `#editor-title`, `#editor-body`, `#editor-status`.
- Mouse: `#mouse-section`, `#click-target`, `#click-count`, `#nav-status`, `#mouse-status`.
- Overlays: `#help`, `#palette`.
- Bindings: `table#bindings`, rows `tr#binding-<ctx>-<action>` with `button#reset-<ctx>-<action>`.
- Rebinding: `form#rebind-form`, `select#rebind-action`, `input#rebind-input`, `button#rebind-apply`, `#rebind-error`, `button#reset-all`, `button#reload-store`.
- Log: `input#debug-toggle`, `button#clear-log`, `ol#log`.
- Persistence: `pre#stored-state`, `#save-status`.

`document.body.dataset.ready` is `'true'` once setup has finished.
