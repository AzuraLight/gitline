/** One row from `git log` machine output. */
export type GitCommitRef = {
  /** Display label (e.g. "main", "origin/main", "v1.2.0"). */
  label: string;
  /** "head" (current branch), "local", "remote", "tag", or "other". */
  kind: "head" | "local" | "remote" | "tag" | "other";
};

export type GitCommitRow = {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  dateSec: number;
  refs: GitCommitRef[];
};

/** Grouped refs for the branch tree (SourceTree-style sidebar). */
export type GitRemoteBranchGroup = { remote: string; branches: string[] };

export type GitBranchTreePayload = {
  current: string;
  locals: string[];
  remotes: GitRemoteBranchGroup[];
};

/** One line from `git blame --porcelain`. */
export type GitWorkingState = {
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
};

export type GitStashEntry = {
  /** Stash ref like `stash@{0}`. */
  ref: string;
  /** Short SHA the stash sits on. */
  parentShort: string;
  subject: string;
  dateSec: number;
};

export type GitCommitFile = {
  /** Single-letter status: A/M/D/R/C/T. */
  status: string;
  /** Repo-relative path after the change (rename target). */
  path: string;
  /** Original path when renamed/copied. */
  oldPath?: string;
  insertions: number;
  deletions: number;
};

