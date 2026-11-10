# Changelog

## 1.6.0

### Added

- **Repositories below the workspace folder are found.** Open a parent folder that is not a
  repository itself and Gitline lists the repositories inside it — by default two levels down
  (`research/json-editor`), where VS Code's own Git stops at one. Set the depth with
  `gitline.repositories.searchDepth` (0–8) and skip folders with
  `gitline.repositories.ignoredFolders` (default `node_modules`). Hidden folders and symbolic
  links are not entered, and the scan is capped so a huge tree cannot stall the panel.
- **Gitline: Open Repository…** — open any repository, also outside the workspace (on the remote
  side in a remote window). It joins a **Recent** list (10, across windows; folders that are
  gone drop out, and the list can be cleared).
- **A better repository picker.** Always available from the repository name in the header, even
  with one repository. Workspace and Recent sections; each entry shows where it sits
  (`teachers/research`), so same-named clones can be told apart; a filter box once there are more
  than six; ↑/↓, Enter and Esc work, and focus stays put when the fresh list arrives. Screen
  readers get a list of options. Opening it re-scans the disk, so a fresh clone shows up. Recent
  repositories are kept per machine kind (local, SSH, WSL, …).

### Fixed

- The repository picker could open partly off-screen to the left.
- Actions (checkout, reset, branch and stash actions, rebase, pull / push) now only run on the
  repository the graph shows. If the target changed underneath — the picked repository was
  deleted, the recent list cleared — the graph reloads and you are asked to try again, instead
  of the action landing on a repository you were not looking at.
- A deleted repository drops out of the picker and stops being the active one right away.
- The same repository reached through different spellings (`/tmp` and `/private/tmp`, letter
  case) shows once. A `.git` that is a symbolic link counts as a repository, as it does for git.

### Internal

- README: a screenshot of the repository picker (light and dark).
- Integration tests also run on a workspace folder that is no repository with repositories one
  and two levels below it (`npm run test:integration:multi-repo`, and in CI on Linux); the
  save-view test waits for the graph instead of retrying the command (one notification, not many).

## 1.5.2

### Fixed

- **Gitline did not activate in Remote SSH windows** ("Cannot activate the 'Gitline'
  extension because it depends on the 'Git' extension, which is not loaded"). Gitline was
  declared a UI extension, so it ran on your local machine while the built-in Git extension —
  and your repository — were on the remote. It now runs in the workspace (remote) extension
  host, like Git Graph and GitLens, which also covers WSL and Dev Containers. The hard
  dependency on the built-in Git extension is gone too: Gitline still uses its repository list
  when it is there, and finds repositories through git itself when it is not.
- Right after opening a file from a repository the Git extension had not discovered yet, the
  graph could show a different repository. Gitline now asks git about that file instead.

### Internal

- Integration tests also run with the built-in Git extension disabled
  (`npm run test:integration:no-git-ext`, and in CI on Linux).

## 1.5.1

### Changed

- **Resizable, collapsible panes.** The branch list, the graph and the preview each
  collapse to a narrow strip from the chevron in their header (or a click on the strip),
  and the two dividers between them drag to resize — or focus one and use ←/→
  (Shift for bigger steps), Enter to collapse, double-click to reset. Dragging far past
  the minimum snaps a pane shut. Sizes and collapsed panes are remembered. The graph and
  the preview never collapse together.
- **Commit messages stay readable next to branch labels.** A local branch and its remote at
  the same commit share one label (`main ⇄`), `origin/HEAD` is no longer shown, and at most
  two labels sit inline — the rest collapse into `+N` with the full list in its tooltip.
  Labels go HEAD, tags, local, remote, so a release tag is not the one hidden.
- **Narrow graph pane:** author, then time, then hash drop out before the message is cut.
- **Branch filter** at the top of the branch list: type to narrow (`origin/` for one remote,
  `chore` for a prefix); Esc clears, ↓ jumps to the first match.
- **Keyboard in the commit list:** ↑/↓, Page Up/Down, Home/End move and open commits;
  Ctrl/Cmd+↓ / ↑ follow the first parent / the child on the same branch; Shift+F10 opens
  the commit menu; Ctrl/Cmd+F jumps to the commit search. The list is a proper listbox
  for screen readers.
- **Toolbar icons** for the merge filters and pull / push / fetch instead of text glyphs,
  each with an accessible name.
- **Relative times follow the display language** ("6분 전", "6分前"). English now reads
  "now" and "yesterday" instead of "just now" and "1d ago"; everything else is unchanged
  ("6m ago", "1mo ago").
- Decorations that are not branches or tags — `stash`, `grafted`, `replace/…` — get the
  neutral "other" label style and sort last, instead of looking like local branches.

### Fixed

- **Local branches with a `/` in the name were coloured as remote branches**
  (`chore/code-cleanup`, `fix/…`). Labels are now classified from full ref names.
- A branch with a comma in its name (`a,b`) showed as two labels.
- **Rebase Continue / Skip that stopped on the next conflict showed git's raw error.**
  git exits with an error there, but the rebase is simply paused again; Gitline now judges by
  the rebase state and shows "Still paused — resolve them in the SCM view, then continue
  again" with git's detail underneath, for Skip as well as Continue.

### Internal

- Dead code removed (an unused message handler, a stale translation, unused exports);
  the rebase continue / skip handlers and error-message formatting share one helper each;
  duplicated toolbar styles are merged and commit-row styles moved out of the
  context-menu stylesheet — the rendered styles are unchanged.
- New pure modules with unit tests: ref labels, keyboard movement, pane layout.
- Integration tests also run on the oldest VS Code that `engines.vscode` allows (1.85), locally
  with `npm run test:integration:minimum` and in CI on Linux.

## 1.5.0

### Added

- **Default view setting** (#1). `gitline.graph.defaultView` opens the graph on the
  current branch (`current`), every branch (`all`), or a chosen set (`selected`) listed
  in `gitline.graph.defaultBranches` — names (`main`, `origin/main`, tags) and patterns
  where `*` matches within one path segment (`origin/team/*`). It applies when the
  panel is created (window start or reload) and when the setting changes; a view you
  pick in the sidebar stays for the session. Leaving the setting unset keeps the old
  behaviour of reopening the last view you used.
- **Pick several branches.** Ctrl/Cmd+click (or Ctrl/Cmd+Enter) in the sidebar adds a
  branch to the view or takes it out — starting from the current branch when you were on
  *HEAD (default log)*. Branches matched by a pattern show as selected, and Ctrl/Cmd+click
  takes one of them out. If a selection matches nothing in a repository (say, after
  switching repos), Gitline shows the default history with a notice but keeps the
  selection for when you switch back.
  The header reads `repo · N branches`, with the list in its tooltip. Commits not on
  the current branch are dimmed as in *All branches*. Selections are passed to git on
  stdin, so hundreds of branches work on Windows too.
- **Gitline: Save Current View as Default** — in the command palette and the branch
  context menu; writes the two settings to workspace settings.

### Changed

- When a selection matches no branch in the repository, the notice now says so
  ("No branch matches …") instead of "no longer exists".
- The sidebar keeps keyboard focus and the remote folders you opened when the graph
  refreshes (it used to rebuild with focus lost and remote folders collapsed).

### Fixed

- **32 messages were never translated** — interactive rebase, compare and the merge
  filters showed English in the Korean UI since 1.0.1. Every message now has an entry in
  both language bundles, and a test checks that new ones do too.

## 1.4.0

### Added

- **All branches view** (#1). A new *All branches* row under *HEAD (default log)* shows
  every local and remote branch and tag in one graph (`git log --branches --remotes
  --tags HEAD` — not `--all`, so stash internals stay out of the graph).
- **Commits not on the current branch are dimmed** (#1). In *All branches*, and when
  you click a single branch, commits that `HEAD` cannot reach fade (text and node); ref
  chips stay readable. Computed by git (`rev-list … --not HEAD`), so it stays right
  with search, merge filters and paging. *HEAD (default log)* is unchanged. Screen
  readers announce dimmed rows as "Not on the current branch".

### Fixed

- **A repository with no commits yet showed a raw git error** ("does not have any
  commits yet") instead of an empty graph. The same happened on an orphan branch
  (`git checkout --orphan`). HEAD's log is now simply empty, and *All branches* still
  lists the other branches when HEAD has no commits.
- **A file named like a branch (or `HEAD`) broke that branch's history** with git's
  "ambiguous argument" error. Revisions are now always ended with `--`, so files can
  never be mistaken for refs.

## 1.3.2

### Fixed

- **Branch lines still bent into a neighbouring column when two lanes waited for the same
  commit** (#1). When a merged branch and a mainline commit share a parent, both lanes
  wait for it until it is drawn. A lane passing a row looked up where it continues by
  hash and took the first match, so it bent into the other lane's column and the line
  broke between the two rows. A lane that is still alive now keeps its own column. The
  same break showed up at fork points, octopus merges and back-to-back merges of
  branches from one commit; every layout test now also checks that the drawn lines
  are connected.

## 1.3.1

### Fixed

- **Branch lines broke off at a fork point and a stray line ran down the graph** (#1).
  When a branch was forked from a commit that other history also leads to, the lane
  waiting for that commit was never released: the branch's line stopped one row short
  of its fork point, and an orphan line continued to the bottom of the graph, pushing
  later branches one column further right. Every lane waiting for a commit now joins
  its node, in the branch's own colour, and is freed there — as `git log --graph` does.

### Changed

- **One-row header** (#1). Title and repository picker sit on the left, search, merge
  filters and pull / push / fetch on the right; the row wraps only when the panel is
  narrow. The full repository path moved into the picker's tooltip.

## 1.3.0

### Added

- **Tree view for changed files** (#1). A List / Tree toggle in the files pane of
  commit, compare and stash details, remembered per workspace. Single-child folder
  chains collapse into one row (`src/main/java/com/example`), each folder shows how
  many files changed under it, and folders open and close with click,
  Enter / Space or ← / →.
- **Inline blame, opt-in** (#2). Turn on `gitline.inlineBlame.enabled` (or run
  *Gitline: Toggle Inline Blame*) to see `author, when · subject` at the end of the
  current line. The hover links to the commit in the Gitline graph and to its patch.
  Unsaved edits are followed, and results are cached until the text or HEAD changes.
- README screenshots (light / dark) and GIFs (#3).

### Fixed

- **File History said "This file is outside the repository" for projects opened
  through a symlink** (and for any
  path where VS Code and git disagree, such as macOS `/var` → `/private/var`). Paths
  are now resolved through symlinks before being made repository-relative.

### Internal

- The webview script and stylesheet are split into components under
  `media/webview/` and `media/styles/`; unused styles from removed views are gone.

## 1.2.1

### Fixed

- **Non-ASCII file names** (한글, 中文, 日本語 …) were shown as escaped octal
  (`"\355\225…"`) and their diffs opened empty. Git output is now read in
  NUL-separated form with `core.quotePath=false`, so every file name works.
- **Only the latest 200 commits were ever shown.** The graph now loads older
  history in pages of 200 as you scroll (up to 5,000 per view).
- **Searching by SHA found nothing** — hex queries were only matched against
  commit messages. A full or partial hash now lists that commit first.
- **Renamed files showed `+0 −0`.** Line counts for renames and copies are now
  correct.
- **The commit details pane closed on every refresh** (saving a file updates
  `.git/index`, which reloads the graph). The selected commit now stays open.
- **Interactive rebase from the root commit** failed with an unknown revision;
  it now uses `--root`.

### Changed

- Pull, push and fetch show a progress notification, stop after 2 minutes, and
  fail fast instead of waiting on a credential prompt that has no terminal.
- Branch and tag names starting with `-` are rejected (git would read them as
  options).

### Internal

- Added unit tests (Mocha) and integration tests (`@vscode/test-cli`), run on
  Linux, macOS and Windows in GitHub Actions.
- The three copies of the changed-files parser (commit, compare, stash) are now
  one function; ref-name validation is shared between the actions and the input
  boxes.

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
