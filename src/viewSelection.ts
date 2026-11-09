// Which refs a graph view shows, as the webview asks for it and as the settings describe it.
// No vscode import: the rules here are unit-tested on their own.

/** Must match GV.ALL_REFS in media/webview/branchTree.js. */
export const ALL_REFS = ":all";

/** `gitline.graph.defaultView` values. */
export type DefaultView = "current" | "all" | "selected";

/** Guards the webview message: at most this many entries are taken from one request. */
const MAX_REVS = 2000;

/**
 * What a request means:
 * - head:   HEAD's own log (nothing selected)
 * - all:    every branch, remote and tag
 * - single: one branch name, clicked in the sidebar (kept as before: unknown → "no longer exists")
 * - list:   several names and/or `*` patterns, resolved against the refs that exist now
 */
export type ViewSelection =
  | { kind: "head" }
  | { kind: "all" }
  | { kind: "single"; rev: string }
  | { kind: "list"; revs: string[] };

/** Trimmed, de-duplicated strings from an untrusted message; `legacyRev` is the pre-1.5 `rev` field. */
export function normalizeRevs(revs: unknown, legacyRev?: unknown): string[] {
  const source: unknown[] = Array.isArray(revs) ? revs : typeof legacyRev === "string" ? [legacyRev] : [];
  const out: string[] = [];
  for (const r of source) {
    if (typeof r !== "string") continue;
    const t = r.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_REVS) break;
  }
  return out;
}

export function classifyRevs(revs: string[]): ViewSelection {
  if (revs.length === 0) return { kind: "head" };
  if (revs.includes(ALL_REFS)) return { kind: "all" };
  if (revs.length === 1 && !revs[0].includes("*")) return { kind: "single", rev: revs[0] };
  return { kind: "list", revs };
}

/** The selection a panel opens with, from the two settings. "selected" with no branches is HEAD's log. */
export function revsForDefaultView(view: unknown, branches: unknown): string[] {
  if (view === "all") return [ALL_REFS];
  if (view === "selected") return normalizeRevs(Array.isArray(branches) ? branches : []);
  return [];
}

/** The settings that reproduce a selection — what "Save Current View as Default" writes. */
export function defaultViewForRevs(revs: string[]): { view: DefaultView; branches: string[] | undefined } {
  const sel = classifyRevs(revs);
  if (sel.kind === "head") return { view: "current", branches: undefined };
  if (sel.kind === "all") return { view: "all", branches: undefined };
  return { view: "selected", branches: sel.kind === "single" ? [sel.rev] : sel.revs };
}
