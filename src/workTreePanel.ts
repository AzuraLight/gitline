import * as path from "path";
import * as vscode from "vscode";
import { commitFileUri } from "./commitShowProvider";
import { errorMessage } from "./errors";
import {
  canStashStagedOnly,
  cleanUntracked,
  commit,
  discardAllTracked,
  discardFile,
  EMPTY_MESSAGE,
  headIsPushed,
  lastCommitMessage,
  NO_COMMIT_YET,
  NOTHING_TO_STASH,
  planDiscard,
  readWorkingFiles,
  stageAll,
  stagePaths,
  stashPush,
  unstagePaths,
  untrackedToClean,
  type WorkGroup,
} from "./workTree";

/**
 * The panel side of the "Working changes" view (1.9.0): turns webview messages into the git
 * operations in workTree.ts, with the confirmations and messages around them. Every write ends with
 * `workFiles` (the webview redraws the lists) and `reloadNow` (the graph, counts, stashes). Writes
 * run one at a time: a second click waits for the first instead of hitting git's index.lock.
 */

export const WORK_WRITE_MESSAGES = [
  "workStage", "workUnstage", "workStageAll", "workUnstageAll", "workCommit",
  "workStash", "workDiscardAll", "workClean", "workDiscardFile",
] as const;

export type WorkMessage = {
  type?: string;
  paths?: unknown;
  path?: unknown;
  group?: unknown;
  message?: unknown;
  amend?: unknown;
};

type Post = (m: unknown) => void;
type Confirm = (message: string, destructive?: boolean) => Promise<boolean>;

const GROUPS: WorkGroup[] = ["staged", "unstaged", "untracked", "conflicted"];
const isGroup = (g: unknown): g is WorkGroup => typeof g === "string" && (GROUPS as string[]).includes(g);

/** Paths from the webview that git currently lists in `group` (or any group) — nothing else is touched. */
async function knownPaths(root: string, raw: unknown, group?: WorkGroup): Promise<string[]> {
  if (!Array.isArray(raw)) return [];
  const files = await readWorkingFiles(root);
  const listed = new Set((group ? files[group] : GROUPS.flatMap((g) => files[g])).map((f) => f.path));
  return raw.filter((p): p is string => typeof p === "string" && listed.has(p));
}

export async function sendWorkFiles(root: string, post: Post): Promise<void> {
  try {
    const [files, stagedOnly] = await Promise.all([readWorkingFiles(root), canStashStagedOnly(root)]);
    // The root lets the webview drop a list that arrives after it switched repositories.
    post({ type: "workFiles", root, files, canStashStagedOnly: stagedOnly });
  } catch (e: unknown) {
    post({ type: "workError", message: errorMessage(e) });
  }
}

async function afterWrite(root: string, post: Post): Promise<void> {
  await sendWorkFiles(root, post);
  post({ type: "reloadNow" });
}

let queue: Promise<unknown> = Promise.resolve();

/** Handles one working-tree message; false when it is not one. Writes are queued (see above). */
export async function handleWorkMessage(root: string, msg: WorkMessage, post: Post, confirm: Confirm): Promise<boolean> {
  const isWrite = (WORK_WRITE_MESSAGES as readonly string[]).includes(msg.type ?? "");
  if (!isWrite) return handleWorkMessageNow(root, msg, post, confirm);
  const run = queue.then(() => handleWorkMessageNow(root, msg, post, confirm));
  queue = run.catch(() => undefined);
  return run;
}

async function handleWorkMessageNow(root: string, msg: WorkMessage, post: Post, confirm: Confirm): Promise<boolean> {
  const fail = (e: unknown) => post({ type: "workError", message: friendly(errorMessage(e)) });
  switch (msg.type) {
    case "requestWorkFiles":
      await sendWorkFiles(root, post);
      return true;
    case "requestAmendMessage": {
      const [message, pushed] = await Promise.all([lastCommitMessage(root), headIsPushed(root)]);
      post({ type: "amendMessage", message, pushed });
      return true;
    }
    case "workStage":
    case "workUnstage": {
      try {
        const paths = await knownPaths(root, msg.paths);
        if (msg.type === "workStage") await stagePaths(root, paths);
        else await unstagePaths(root, paths);
      } catch (e: unknown) {
        fail(e);
      }
      await afterWrite(root, post);
      return true;
    }
    case "workStageAll":
      try {
        await stageAll(root);
      } catch (e: unknown) {
        fail(e);
      }
      await afterWrite(root, post);
      return true;
    case "workUnstageAll":
      try {
        await unstagePaths(root, (await readWorkingFiles(root)).staged.map((f) => f.path));
      } catch (e: unknown) {
        fail(e);
      }
      await afterWrite(root, post);
      return true;
    case "workCommit":
      try {
        await commitFromPanel(root, msg, post, confirm);
      } finally {
        // Also after a "no" in a confirmation: the webview unlocks its Commit button on this.
        post({ type: "workSettled" });
      }
      return true;
    case "workStash":
      await stashFromPanel(root, post);
      return true;
    case "workDiscardAll":
      await discardAllFromPanel(root, post, confirm);
      return true;
    case "workClean":
      await cleanFromPanel(root, post, confirm);
      return true;
    case "workDiscardFile":
      await discardFileFromPanel(root, msg, post, confirm);
      return true;
    case "openWorkDiff":
      await openWorkDiff(root, msg);
      return true;
    default:
      return false;
  }
}

function friendly(raw: string): string {
  if (raw.includes(EMPTY_MESSAGE)) return vscode.l10n.t("Write a commit message first.");
  if (raw.includes(NO_COMMIT_YET)) return vscode.l10n.t("There is no commit yet to go back to.");
  if (raw.includes(NOTHING_TO_STASH)) return vscode.l10n.t("Nothing was stashed: the chosen changes are empty.");
  return raw;
}

async function commitFromPanel(root: string, msg: WorkMessage, post: Post, confirm: Confirm): Promise<void> {
  const message = typeof msg.message === "string" ? msg.message : "";
  const amend = msg.amend === true;
  if (!message.trim()) {
    post({ type: "workError", message: friendly(EMPTY_MESSAGE) });
    return;
  }
  try {
    const files = await readWorkingFiles(root);
    if (files.conflicted.length) {
      post({ type: "workError", message: vscode.l10n.t("Resolve the conflicted files first.") });
      return;
    }
    if (!files.staged.length && !amend) {
      const changes = files.unstaged.length + files.untracked.length;
      if (!changes) {
        post({ type: "workError", message: vscode.l10n.t("There are no changes to commit.") });
        return;
      }
      // As VS Code's own commit does: nothing staged → offer to commit everything.
      if (!(await confirm(vscode.l10n.t("Nothing is staged. Stage all {0} changes and commit them?", String(changes))))) return;
      await stageAll(root);
    }
    if (amend && (await headIsPushed(root))) {
      const ok = await confirm(
        vscode.l10n.t("The last commit is already pushed. Amending it rewrites it, so the next push needs Force push (with lease). Amend anyway?"),
        true,
      );
      if (!ok) return;
    }
    await commit(root, message, { amend });
    post({ type: "workCommitted" });
  } catch (e: unknown) {
    post({ type: "workError", message: friendly(errorMessage(e)) });
  }
  await afterWrite(root, post);
}

async function stashFromPanel(root: string, post: Post): Promise<void> {
  const files = await readWorkingFiles(root);
  if (!files.staged.length && !files.unstaged.length && !files.untracked.length) {
    post({ type: "workError", message: vscode.l10n.t("There are no changes to stash.") });
    return;
  }
  const message = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Stash message (optional)"),
    placeHolder: vscode.l10n.t("e.g. half-done login form"),
  });
  if (message === undefined) return;
  type Pick = vscode.QuickPickItem & { opts: { includeUntracked?: boolean; stagedOnly?: boolean } };
  const tracked = files.staged.length + files.unstaged.length > 0;
  const picks: Pick[] = [
    { label: vscode.l10n.t("All changes, with untracked files"), opts: { includeUntracked: true } },
  ];
  // Only offered when there is something for it to stash.
  if (tracked && files.untracked.length) {
    picks.push({ label: vscode.l10n.t("Changes to tracked files only"), description: vscode.l10n.t("untracked files stay"), opts: { includeUntracked: false } });
  }
  if (files.staged.length && (await canStashStagedOnly(root))) {
    picks.push({ label: vscode.l10n.t("Staged changes only"), description: vscode.l10n.t("the rest stays"), opts: { stagedOnly: true } });
  }
  const pick = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t("What to stash") });
  if (!pick) return;
  try {
    await stashPush(root, { message, ...pick.opts });
  } catch (e: unknown) {
    post({ type: "workError", message: friendly(errorMessage(e)) });
  }
  await afterWrite(root, post);
}

async function discardAllFromPanel(root: string, post: Post, confirm: Confirm): Promise<void> {
  const files = await readWorkingFiles(root);
  const n = new Set([...files.staged, ...files.unstaged, ...files.conflicted].map((f) => f.path)).size;
  if (!n) {
    post({ type: "workError", message: vscode.l10n.t("There are no changes to tracked files to discard.") });
    return;
  }
  const ok = await confirm(
    vscode.l10n.t("Discard all changes to {0} tracked file(s), staged or not? This cannot be undone. Untracked files are kept.", String(n)),
    true,
  );
  if (!ok) return;
  try {
    await discardAllTracked(root);
  } catch (e: unknown) {
    post({ type: "workError", message: friendly(errorMessage(e)) });
  }
  await afterWrite(root, post);
}

async function cleanFromPanel(root: string, post: Post, confirm: Confirm): Promise<void> {
  const list = await untrackedToClean(root);
  if (!list.length) {
    post({ type: "workError", message: vscode.l10n.t("There are no untracked files to delete.") });
    return;
  }
  const shown = list.slice(0, 8).join("\n") + (list.length > 8 ? `\n… +${list.length - 8}` : "");
  const ok = await confirm(
    vscode.l10n.t("Delete {0} untracked file(s) and folder(s)? This cannot be undone. Ignored files are kept.\n\n{1}", String(list.length), shown),
    true,
  );
  if (!ok) return;
  try {
    await cleanUntracked(root);
  } catch (e: unknown) {
    post({ type: "workError", message: friendly(errorMessage(e)) });
  }
  await afterWrite(root, post);
}

async function discardFileFromPanel(root: string, msg: WorkMessage, post: Post, confirm: Confirm): Promise<void> {
  if (!isGroup(msg.group) || msg.group === "conflicted") return;
  const file = typeof msg.path === "string" ? msg.path : "";
  const plan = file ? await planDiscard(root, file, msg.group) : null;
  if (!plan) {
    await afterWrite(root, post); // the list was stale: show the current one
    return;
  }
  const text =
    plan.kind === "deleteUntracked"
      ? vscode.l10n.t("Delete the untracked file {0}? This cannot be undone.", file)
      : plan.kind === "deleteNew"
        ? vscode.l10n.t("{0} is a new file that is in no commit. Delete it? Its content cannot be recovered.", file)
        : plan.kind === "renameBack"
          ? vscode.l10n.t("Undo the rename {0} → {1}? {0} comes back as in the last commit and {1} is deleted, with its changes. This cannot be undone.", plan.orig, file)
          : msg.group === "staged"
            ? vscode.l10n.t("Discard all changes to {0}, staged and not, back to the last commit? This cannot be undone.", file)
            : vscode.l10n.t("Discard the unstaged changes to {0}? This cannot be undone.", file);
  if (!(await confirm(text, true))) return;
  try {
    await discardFile(root, file, msg.group);
  } catch (e: unknown) {
    post({ type: "workError", message: friendly(errorMessage(e)) });
  }
  await afterWrite(root, post);
}

type GitApi = { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri };

/** The built-in Git extension's API when it is there: its URIs let VS Code stage selected lines from the diff. */
function gitApi(): GitApi | null {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>("vscode.git");
  try {
    return ext?.isActive ? ext.exports.getAPI(1) : null;
  } catch {
    return null;
  }
}

/**
 * A changed file's diff: staged → HEAD vs index; unstaged → index vs the working file (where VS
 * Code offers "Stage Selected Ranges"); untracked → the file itself. With the built-in Git
 * extension the sides are its git: URIs; without it, Gitline's own read-only views.
 */
async function openWorkDiff(root: string, msg: WorkMessage): Promise<void> {
  if (!isGroup(msg.group)) return;
  const [file] = await knownPaths(root, [msg.path], msg.group);
  if (!file) return;
  const abs = vscode.Uri.file(path.join(root, file));
  const title = path.basename(file);
  try {
    if (msg.group === "untracked" || msg.group === "conflicted") {
      await vscode.window.showTextDocument(abs, { preview: true });
      return;
    }
    const api = gitApi();
    const index = api ? api.toGitUri(abs, "") : commitFileUri(root, "INDEX", file);
    if (msg.group === "staged") {
      const head = api ? api.toGitUri(abs, "HEAD") : commitFileUri(root, "HEAD", file);
      await vscode.commands.executeCommand("vscode.diff", head, index, vscode.l10n.t("{0} (Index)", title), { preview: true });
    } else {
      await vscode.commands.executeCommand("vscode.diff", index, abs, vscode.l10n.t("{0} (Working Tree)", title), { preview: true });
    }
  } catch (e: unknown) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Gitline: {0}", errorMessage(e)));
  }
}
