# Changelog

## 1.2.0

### Added

- **Multi-repo support.** When the window contains more than one Git repository
  (a multi-root workspace or a monorepo with several checkouts), the repo name in
  the panel header becomes a picker (▾). Choose any repo to switch the whole view
  — graph, branches, stashes, and actions all follow the selection, which is
  remembered per workspace.
- **Remote sync toolbar.** The header gains **Pull / Push / Fetch** buttons.
  Push targets the current branch's configured upstream (publishing to `origin`
  with `-u` when it has none); Pull is fast-forward-only; Fetch runs
  `fetch --all --prune`. An `↑ahead ↓behind` badge shows how the current branch
  compares to its upstream.
- **Force push (with lease).** Local branches gain a **Force push (with lease)**
  context-menu action so a rebased/amended branch can be pushed safely — it
  refuses if the remote moved unexpectedly.
- New commands: **Gitline: Pull**, **Gitline: Push**, **Gitline: Fetch All**.

## 1.1.0

### Added

- **Interactive rebase — conflict recovery.** When a rebase pauses (typically a
  conflict), the panel now shows a banner with **Continue / Skip / Abort** so you
  can finish the rebase after resolving in the SCM view, instead of only being
  able to abort.

### Fixed

- Interactive rebase no longer hangs on `squash` / `fixup` / `reword` steps: the
  combined commit message is accepted automatically rather than waiting on a
  commit-message editor that has no terminal.
- In-progress-rebase detection now resolves the rebase state directory via
  `git rev-parse --git-path`, so it is correct in worktrees and submodules
  (where `.git` is a file, not a directory).

### Docs

- README now documents the **interactive rebase** and **compare two commits**
  features (shipped earlier but undocumented), and the Limitations section
  reflects the real gaps (single-repo, `origin`-only push, no top-level pull).

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
