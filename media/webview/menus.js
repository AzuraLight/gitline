// Context-menu item lists for commits, branches and stashes. Each entry only posts a message
// or calls an app action — the extension host does the actual git work.
(function (GV) {
  "use strict";

  GV.createMenus = function (app) {
    var UI = app.UI;
    var S = app.state;
    var post = app.post;
    var show = GV.contextMenu.show;

    /** The "Working changes" row: stash, the two discards (both confirmed by the host), Source Control. */
    function forWorking(x, y) {
      show(x, y, [
        { label: UI.workStash || "Stash…", run: function () { post("workStash", {}); } },
        "-",
        { label: UI.workDiscardAll || "Discard all changes to tracked files…", danger: true, run: function () { post("workDiscardAll", {}); } },
        { label: UI.workCleanUntracked || "Delete untracked files…", danger: true, run: function () { post("workClean", {}); } },
        "-",
        { label: UI.workOpenScm || "Source Control", run: function () { post("focusScm", {}); } },
      ]);
    }

    function commitAction(action, hash) {
      return function () { post("commitAction", { action: action, hash: hash }); };
    }
    function branchAction(action, branch) {
      return function () { post("branchAction", { action: action, branch: branch }); };
    }
    function stashAction(action, ref) {
      return function () { post("stashAction", { action: action, hash: ref }); };
    }
    function copy(text) {
      return function () { post("copyText", { text: text }); };
    }

    function compareItems(c) {
      var items = [];
      if (S.markedHash && S.markedHash !== c.hash) {
        items.push(
          { label: UI.ctxCompareWithMarkedFiles || "Compare with marked → files", run: function () { app.actions.compareWithMarked(c.hash); } },
          { label: UI.ctxCompareWithMarkedDiff || "Compare with marked → patch", run: function () { post("openComparePatch", { a: S.markedHash, b: c.hash }); } }
        );
      }
      if (S.markedHash === c.hash) {
        items.push({ label: UI.ctxUnmarkCompare || "Unmark compare base", run: function () { app.actions.setMarked(""); } });
      } else {
        items.push({ label: UI.ctxMarkForCompare || "Mark for compare", run: function () { app.actions.setMarked(c.hash); } });
      }
      return items;
    }

    function forCommit(c, x, y) {
      var h = c.hash;
      var items = [
        { label: "Checkout (detached)", run: commitAction("checkout-detached", h) },
        { label: "Create branch here…", run: function () { post("createBranchAt", { hash: h }); } },
        { label: "Create tag here…", run: function () { post("createTagAt", { hash: h }); } },
        "-",
        { label: "Cherry-pick", run: commitAction("cherry-pick", h) },
        { label: "Revert", run: commitAction("revert", h) },
        { label: "Merge into current", run: commitAction("merge-commit", h) },
        { label: "Rebase current onto", run: commitAction("rebase-onto", h) },
        "-",
        { label: "Reset — soft", run: commitAction("reset-soft", h) },
        { label: "Reset — mixed", run: commitAction("reset-mixed", h) },
        { label: "Reset — hard", danger: true, run: commitAction("reset-hard", h) },
        "-",
      ].concat(compareItems(c), [
        "-",
        { label: UI.ctxRebaseFromHere || "Interactive rebase from here…", run: function () { app.actions.startRebase(h); } },
        "-",
        { label: "Copy SHA", run: copy(h) },
        { label: "Copy message", run: copy(c.subject || "") },
        { label: "Open patch view", run: function () { post("openCommitPatch", { hash: h }); } },
      ]);
      show(x, y, items);
    }

    function forLocalBranch(name, isCurrent, x, y) {
      var items = isCurrent ? [] : [{ label: "Checkout", run: branchAction("branch-checkout", name) }];
      show(x, y, items.concat([
        { label: "Merge into current", run: branchAction("branch-merge-into-current", name) },
        { label: "Rebase current onto", run: branchAction("branch-rebase-current-onto", name) },
        "-",
        { label: "Push", run: branchAction("branch-push", name) },
        { label: "Force push (with lease)", danger: true, run: branchAction("branch-push-force", name) },
        { label: "Rename…", run: function () { post("renameBranch", { branch: name }); } },
        "-",
        { label: "Delete", danger: true, run: branchAction("branch-delete", name) },
        { label: "Force delete", danger: true, run: branchAction("branch-delete-force", name) },
        "-",
        { label: "Copy name", run: copy(name) },
        { label: "Save current view as default", run: app.actions.saveViewAsDefault },
      ]));
    }

    function forRemoteBranch(name, x, y) {
      show(x, y, [
        { label: "Create local branch tracking this", run: branchAction("branch-checkout-remote", name) },
        { label: "Fetch", run: branchAction("branch-fetch", name) },
        { label: "Merge into current", run: branchAction("branch-merge-into-current", name) },
        "-",
        { label: "Delete on remote", danger: true, run: branchAction("branch-delete-remote", name) },
        "-",
        { label: "Copy name", run: copy(name) },
        { label: "Save current view as default", run: app.actions.saveViewAsDefault },
      ]);
    }

    function forStash(st, x, y) {
      show(x, y, [
        { label: "Apply", run: stashAction("stash-apply", st.ref) },
        { label: "Pop", run: stashAction("stash-pop", st.ref) },
        { label: "Drop", danger: true, run: stashAction("stash-drop", st.ref) },
        "-",
        { label: "Copy ref", run: copy(st.ref) },
      ]);
    }

    return { forWorking: forWorking, forCommit: forCommit, forLocalBranch: forLocalBranch, forRemoteBranch: forRemoteBranch, forStash: forStash };
  };
})(window.GV = window.GV || {});
