# Changelog

## 1.0.1

### Fixed

- Selecting a branch/rev that no longer resolves (a deleted or renamed remote
  branch, or a typo) no longer fails the whole graph with git's
  "unknown revision" fatal error. The view now falls back to the default
  history, shows a dismissible notice naming the missing ref, and clears the
  stale selection so it isn't re-requested.

## 1.0.0

First public release.

### Commit graph

- SVG-based lane graph with color-coded branches and bezier merge curves.
- Ref chips inline (HEAD, local, remote, tag).
- Search bar: free text → `--grep`, `@name` → `--author`, hex prefix → SHA.
- Working changes virtual row when the tree is dirty; click to focus the SCM view.
- Stash rows with apply / pop / drop actions.
- Right pane shows files changed for the selected commit/stash; click a file to open VS Code's native diff editor.
- "Patch" button opens the full `git show` output.

### Right-click context menus

- Commit: checkout (detached), create branch / tag, cherry-pick, revert, merge, rebase, reset (soft/mixed/hard), copy SHA / message.
- Local branch: checkout, merge / rebase, push, rename, delete (-d / -D), copy name.
- Remote branch: create tracking branch, fetch, merge, delete on remote, copy name.
- Stash: apply, pop, drop, copy ref.

### Performance

- Virtual scrolling: only the visible window of commit rows is rendered.
- Auto-refresh via `.git/{HEAD,refs/**,index,packed-refs,FETCH_HEAD}` file watcher.

### Other

- File history: graph filtered to a single file with `--follow` rename tracking.
- Korean localization.
- MIT licensed, telemetry-free, no account required.
