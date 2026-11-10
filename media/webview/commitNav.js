// Keyboard movement in the commit list. No DOM — also loaded by the unit tests under Node.
(function (factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (window.GV = window.GV || {}).commitNav = api;
})(function () {
  "use strict";

  /**
   * Where a plain key moves the selection: ↑/↓ one row, PageUp/PageDown one screen, Home/End to
   * the ends. from = -1 means nothing selected yet (↓ / Home start at the top, ↑ / End at the
   * bottom). Returns -1 for keys this function does not handle.
   */
  function stepIndex(from, key, count, page) {
    if (count <= 0) return -1;
    var last = count - 1;
    var p = Math.max(1, page || 1);
    var none = from < 0;
    switch (key) {
      case "ArrowDown": return none ? 0 : Math.min(last, from + 1);
      case "ArrowUp": return none ? last : Math.max(0, from - 1);
      case "PageDown": return none ? Math.min(last, p - 1) : Math.min(last, from + p);
      case "PageUp": return none ? 0 : Math.max(0, from - p);
      case "Home": return 0;
      case "End": return last;
      default: return -1;
    }
  }

  /** Ctrl/Cmd+↓: the first parent of row i, if it is loaded (-1 otherwise). */
  function parentIndex(commits, i, indexOfHash) {
    var c = commits[i];
    if (!c || !c.parents || !c.parents.length) return -1;
    var j = indexOfHash[c.parents[0]];
    return typeof j === "number" ? j : -1;
  }

  /**
   * Ctrl/Cmd+↑: the nearest newer row that continues this line — preferring a child whose
   * *first* parent is row i (same branch), else any child (e.g. the merge that brought it in).
   */
  function childIndex(commits, i) {
    var c = commits[i];
    if (!c) return -1;
    var anyChild = -1;
    for (var j = i - 1; j >= 0; j--) {
      var ps = commits[j].parents || [];
      if (ps[0] === c.hash) return j;
      if (anyChild < 0 && ps.indexOf(c.hash) >= 0) anyChild = j;
    }
    return anyChild;
  }

  return { stepIndex: stepIndex, parentIndex: parentIndex, childIndex: childIndex };
});
