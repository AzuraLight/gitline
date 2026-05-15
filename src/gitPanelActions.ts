import { runGitCommand } from "./gitExec";

export const COMMIT_ACTION_IDS = [
  "checkout-detached",
  "merge-commit",
  "rebase-onto",
  "cherry-pick",
  "revert",
  "reset-soft",
  "reset-mixed",
  "reset-hard",
] as const;
export type CommitActionId = (typeof COMMIT_ACTION_IDS)[number];
export function isCommitActionId(v: string): v is CommitActionId {
  return (COMMIT_ACTION_IDS as readonly string[]).includes(v);
}

export const BRANCH_ACTION_IDS = [
  "branch-checkout",
  "branch-delete",
  "branch-delete-force",
  "branch-fetch",
  "branch-push",
  "branch-merge-into-current",
  "branch-rebase-current-onto",
  "branch-checkout-remote",
  "branch-delete-remote",
] as const;
export type BranchActionId = (typeof BRANCH_ACTION_IDS)[number];
export function isBranchActionId(v: string): v is BranchActionId {
  return (BRANCH_ACTION_IDS as readonly string[]).includes(v);
}

export const STASH_ACTION_IDS = ["stash-apply", "stash-pop", "stash-drop"] as const;
export type StashActionId = (typeof STASH_ACTION_IDS)[number];
export function isStashActionId(v: string): v is StashActionId {
  return (STASH_ACTION_IDS as readonly string[]).includes(v);
}

const HASH_OK = /^[0-9a-f]{7,40}$/i;
const REF_OK = /^[^\s~^:?*\\]+$/;
const STASH_OK = /^stash@\{\d+\}$/;

export function assertCommitHash(hash: string): string {
  const t = hash.trim();
  if (!HASH_OK.test(t)) {
    throw new Error("Invalid commit hash");
  }
  return t;
}

export function assertRefName(name: string): string {
  const t = name.trim();
  if (!t || !REF_OK.test(t)) {
    throw new Error("Invalid ref name");
  }
  return t;
}

export function assertStashRef(ref: string): string {
  const t = ref.trim();
  if (!STASH_OK.test(t)) {
    throw new Error("Invalid stash ref");
  }
  return t;
}

export async function runCommitAction(cwd: string, action: CommitActionId, rawHash: string): Promise<void> {
  const hash = assertCommitHash(rawHash);
  switch (action) {
    case "checkout-detached":
      await runGitCommand(cwd, ["checkout", "--detach", hash]);
      return;
    case "merge-commit":
      await runGitCommand(cwd, ["merge", hash]);
      return;
    case "rebase-onto":
      await runGitCommand(cwd, ["rebase", hash]);
      return;
    case "cherry-pick":
      await runGitCommand(cwd, ["cherry-pick", hash]);
      return;
    case "revert":
      await runGitCommand(cwd, ["revert", "--no-edit", hash]);
      return;
    case "reset-soft":
      await runGitCommand(cwd, ["reset", "--soft", hash]);
      return;
    case "reset-mixed":
      await runGitCommand(cwd, ["reset", "--mixed", hash]);
      return;
    case "reset-hard":
      await runGitCommand(cwd, ["reset", "--hard", hash]);
      return;
  }
}

/** Branch actions. For remote-branch operations, `branch` is the full `origin/foo` form. */
export async function runBranchAction(cwd: string, action: BranchActionId, branch: string): Promise<void> {
  const name = assertRefName(branch);
  switch (action) {
    case "branch-checkout":
      await runGitCommand(cwd, ["checkout", name]);
      return;
    case "branch-delete":
      await runGitCommand(cwd, ["branch", "-d", name]);
      return;
    case "branch-delete-force":
      await runGitCommand(cwd, ["branch", "-D", name]);
      return;
    case "branch-fetch": {
      // `origin/foo` → fetch origin foo
      const slash = name.indexOf("/");
      if (slash > 0) {
        const remote = name.slice(0, slash);
        const local = name.slice(slash + 1);
        await runGitCommand(cwd, ["fetch", remote, local]);
      } else {
        await runGitCommand(cwd, ["fetch"]);
      }
      return;
    }
    case "branch-push":
      await runGitCommand(cwd, ["push", "-u", "origin", name]);
      return;
    case "branch-merge-into-current":
      await runGitCommand(cwd, ["merge", name]);
      return;
    case "branch-rebase-current-onto":
      await runGitCommand(cwd, ["rebase", name]);
      return;
    case "branch-checkout-remote": {
      // From `origin/foo` create local `foo` tracking it.
      const slash = name.indexOf("/");
      const local = slash > 0 ? name.slice(slash + 1) : name;
      await runGitCommand(cwd, ["checkout", "-b", local, "--track", name]);
      return;
    }
    case "branch-delete-remote": {
      const slash = name.indexOf("/");
      if (slash <= 0) throw new Error("Expected remote/branch");
      const remote = name.slice(0, slash);
      const remoteBranch = name.slice(slash + 1);
      await runGitCommand(cwd, ["push", remote, "--delete", remoteBranch]);
      return;
    }
  }
}

export async function runStashAction(cwd: string, action: StashActionId, rawRef: string): Promise<void> {
  const ref = assertStashRef(rawRef);
  switch (action) {
    case "stash-apply":
      await runGitCommand(cwd, ["stash", "apply", ref]);
      return;
    case "stash-pop":
      await runGitCommand(cwd, ["stash", "pop", ref]);
      return;
    case "stash-drop":
      await runGitCommand(cwd, ["stash", "drop", ref]);
      return;
  }
}

/** Branch with given name from `<refspec>`. Refspec may be a hash or ref. */
export async function createBranchFrom(cwd: string, name: string, refspec: string): Promise<void> {
  const b = assertRefName(name);
  await runGitCommand(cwd, ["branch", b, refspec]);
}

/** Lightweight tag at `<refspec>`. */
export async function createTagAt(cwd: string, name: string, refspec: string): Promise<void> {
  const t = assertRefName(name);
  await runGitCommand(cwd, ["tag", t, refspec]);
}

export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
  const o = assertRefName(oldName);
  const n = assertRefName(newName);
  await runGitCommand(cwd, ["branch", "-m", o, n]);
}
