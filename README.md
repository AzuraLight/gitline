# Gitline

A clean, fast commit graph for VS Code — **free, MIT, no account, no telemetry**.

Gitline is a focused alternative to GitLens that puts a real Git graph in the bottom panel. SVG lanes, color-coded branches, working changes and stashes inline, file-level diff with one click, right-click actions for everyday Git work.

![Commit graph in the bottom panel](media/icon.png)

## Why Gitline

- **Commit graph is the product.** Not paywalled, not behind a sign-in.
- **MIT licensed.** Use it, fork it, ship it.
- **No telemetry, no account.** Opens and works.
- **Native VS Code feel.** Uses VS Code theme tokens, integrates with the built-in Git extension.

## Features

### Commit graph (panel)

- **SVG lane graph** — color-coded branches with smooth bezier merges.
- **Ref chips** inline next to each commit: `HEAD`, local, remote, tag.
- **Search bar** — text, `@author`, or partial SHA. 280 ms debounce, server-side `git log --grep` / `--author`.
- **File-level history** — open the graph filtered to a single file (`--follow` for renames). Editor title bar button + explorer context menu.
- **Auto-refresh** — `.git/HEAD`, `refs/**`, `index` watched. Commit, checkout, fetch, stage — graph reloads automatically.
- **Virtual scrolling** — only the visible window of commit rows is in the DOM. Stays responsive on large histories.

### Working tree and stashes

- **Working changes** row at the top of the graph when there are uncommitted changes (`3 staged · 5 modified · 2 untracked`). Click to focus the SCM view.
- **Stashes** as their own rows. Click for the file list; right-click for **apply / pop / drop**.

### Click a commit

- Right pane shows the **changed files** with status badge (`A` / `M` / `D` / `R` / `C`) and `+N −M` line counts.
- Click a file → native VS Code diff editor, with rename-aware before/after paths.
- "Patch" button opens the full `git show` as a tab.

### Right-click context menus

| Target | Actions |
|---|---|
| **Commit** | Checkout (detached) · Create branch / tag here · Cherry-pick · Revert · Merge / Rebase · Reset (soft / mixed / hard) · Copy SHA / message · Open patch |
| **Local branch** | Checkout · Merge / Rebase · Push · Rename · Delete / Force delete · Copy name |
| **Remote branch** | Create tracking branch · Fetch · Merge · Delete on remote · Copy name |
| **Stash** | Apply · Pop · Drop · Copy ref |

Destructive actions show a modal confirmation. Branch/tag creation and rename prompt for the name.

## Getting started

1. Install from the Marketplace (search **Gitline**) or via VSIX.
2. Open a folder that is, or contains, a Git repository.
3. Press <kbd>Cmd</kbd>+<kbd>J</kbd> / <kbd>Ctrl</kbd>+<kbd>J</kbd> to open the panel, click the **Gitline** tab.
4. Or run **Gitline: Open Commit Panel** from the command palette.

For per-file history: right-click any file → **Gitline: File History**, or use the history icon in the editor title bar.

## Commands

| Command | What it does |
|---|---|
| `Gitline: Open Commit Panel` | Reveals the graph panel and reloads. |
| `Gitline: File History` | Opens the graph filtered to the current file. |

## How it compares

| | Gitline | GitLens (free) | GitLens (Pro) | Git Graph (mhutchie) |
|---|---|---|---|---|
| Commit graph | ✅ | — | ✅ ($) | ✅ |
| Right-click branch/commit actions | ✅ | partial | ✅ | ✅ |
| Working changes + stashes in graph | ✅ | — | partial | — |
| Search by author / message / SHA | ✅ | partial | ✅ | partial |
| File history view | ✅ | ✅ | ✅ (visual) | ✅ |
| No account / no sign-in | ✅ | — (account prompts) | — | ✅ |
| Telemetry-free | ✅ | — | — | ✅ |
| License | MIT | proprietary | proprietary | MIT |

## Requirements

- VS Code 1.85+
- Git on `PATH`
- The built-in `vscode.git` extension (bundled)

## Limitations (v1.0)

- Single-repo workspaces. Multi-root with multiple repos picks the first.
- No interactive rebase editor yet.
- No two-commit compare picker yet.

Both are on the v1.1 roadmap.

## Contributing

```bash
git clone https://github.com/AzuraLight/gitline
cd gitline
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host.
```

Bug reports and PRs welcome at [github.com/AzuraLight/gitline/issues](https://github.com/AzuraLight/gitline/issues).

## License

[MIT](LICENSE) © Azura
