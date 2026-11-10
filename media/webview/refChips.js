// Ref labels on a commit row: which to show and how. No DOM in groupRefs — also loaded by the
// unit tests under Node.
(function (factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (window.GV = window.GV || {}).refChips = api;
})(function () {
  "use strict";

  /** Labels shown inline; the rest collapse into one "+N" chip (its tooltip lists them). */
  var MAX_INLINE = 2;
  // HEAD first (where you are), then tags: they are few and mark releases, so they should not be
  // the ones hidden behind "+N" by a pair of branches. Remote-only branches can be many.
  var ORDER = { head: 0, tag: 1, local: 2, remote: 3, other: 4 };

  /**
   * refs: [{ label, kind }] from the host (kind head | local | remote | tag | other).
   * - a remote's symbolic HEAD (origin/HEAD) is dropped: it only repeats another remote branch;
   * - a remote branch at the same commit as the local branch of that name folds into the local
   *   label (`main` + `origin/main` → one `main` label that lists `origin` in `remotes`);
   * - order: HEAD / current branch, tags, local branches, remote branches, anything else.
   */
  function groupRefs(refs) {
    var chips = [];
    var locals = {};
    (refs || []).forEach(function (r) {
      if (!r || typeof r.label !== "string") return;
      if (r.kind === "head" || r.kind === "local") {
        var chip = { label: r.label, kind: r.kind, remotes: [] };
        if (r.label !== "HEAD") locals[r.label] = chip;
        chips.push(chip);
      }
    });
    (refs || []).forEach(function (r) {
      if (!r || typeof r.label !== "string" || r.kind === "head" || r.kind === "local") return;
      if (r.kind === "remote") {
        var slash = r.label.indexOf("/");
        var remote = slash > 0 ? r.label.slice(0, slash) : "";
        var name = slash > 0 ? r.label.slice(slash + 1) : r.label;
        if (name === "HEAD") return;
        if (remote && locals[name]) {
          locals[name].remotes.push(remote);
          return;
        }
      }
      chips.push({ label: r.label, kind: ORDER.hasOwnProperty(r.kind) ? r.kind : "other", remotes: [] });
    });
    return chips
      .map(function (c, i) { return { c: c, i: i }; })
      .sort(function (a, b) { return (ORDER[a.c.kind] - ORDER[b.c.kind]) || (a.i - b.i); })
      .map(function (x) { return x.c; });
  }

  /** { shown, hidden }: the first MAX_INLINE labels, and the rest for the "+N" chip. */
  function splitInline(chips, max) {
    var limit = typeof max === "number" ? max : MAX_INLINE;
    // "+1" would take as much room as the label it hides; show that one instead.
    if (chips.length <= limit + 1) return { shown: chips.slice(), hidden: [] };
    return { shown: chips.slice(0, limit), hidden: chips.slice(limit) };
  }

  /** One line per label for tooltips: "main  ⇄ origin", "v1.4.0  (tag)". */
  function describe(chip) {
    var s = chip.label;
    if (chip.remotes && chip.remotes.length) s += "  ⇄ " + chip.remotes.join(", ");
    if (chip.kind === "tag") s += "  (tag)";
    if (chip.kind === "head" && chip.label !== "HEAD") s += "  (HEAD)";
    return s;
  }

  return { groupRefs: groupRefs, splitInline: splitInline, describe: describe, MAX_INLINE: MAX_INLINE };
});
