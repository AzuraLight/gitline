// Center pane: working-changes / stash rows, the virtualised commit rows and the SVG lane graph.
(function (GV) {
  "use strict";
  var u = GV.util;

  var METRICS = { rowH: 30, laneW: 14, nodeR: 5, sidePad: 10 };
  var MAX_GRAPH_W = 220; // cap so commit text never gets pushed off-screen
  var BUFFER = 8;        // rows rendered beyond the viewport on each side

  GV.createCommitList = function (app, detailPane, menus) {
    var UI = app.UI;
    var S = app.state;
    var root = document.getElementById("graph-root");
    var svg = document.getElementById("graph-svg");
    var canvas = root.parentElement;
    var scrollHandler = null;
    var activeList = null; // the mounted list's selection API (rebuilt on every render)

    // ---- Keyboard: the commit list is one listbox ---------------------------------------------
    root.setAttribute("role", "listbox");
    root.setAttribute("tabindex", "0");
    root.setAttribute("aria-label", UI.commitListAria || "Commits");
    root.addEventListener("keydown", function (ev) {
      var L = activeList;
      if (!L || !L.count) return;
      var cur = L.selectedIndex();
      var mod = ev.ctrlKey || ev.metaKey;
      var next = -1;
      if (mod && ev.key === "ArrowDown") next = cur >= 0 ? L.parentIndex(cur) : -1;
      else if (mod && ev.key === "ArrowUp") next = cur >= 0 ? L.childIndex(cur) : -1;
      else if (!mod && !ev.altKey) next = GV.commitNav.stepIndex(cur, ev.key, L.count, L.pageRows());
      if (next >= 0) {
        ev.preventDefault();
        L.selectIndex(next, true);
        if (next >= L.count - BUFFER) app.loadMore();
        return;
      }
      if ((ev.key === "Enter" || ev.key === " ") && cur >= 0) {
        ev.preventDefault();
        L.selectIndex(cur, true);
        return;
      }
      // Context menu from the keyboard (Shift+F10 / the Menu key), placed at the row.
      if ((ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) && cur >= 0) {
        ev.preventDefault();
        L.selectIndex(cur, true);
        var el = L.rowEl(cur);
        var r = el ? el.getBoundingClientRect() : root.getBoundingClientRect();
        menus.forCommit(L.commit(cur), r.left + 40, r.top + r.height);
      }
    });

    function formatWorkingSummary(w) {
      var parts = [];
      if (w.staged) parts.push(w.staged + " staged");
      if (w.modified) parts.push(w.modified + " modified");
      if (w.untracked) parts.push(w.untracked + " untracked");
      if (w.conflicted) parts.push(w.conflicted + " conflicted");
      return parts.join("  ·  ");
    }

    function sizeRow(row, graphWidth) {
      row.style.height = METRICS.rowH + "px";
      row.style.minHeight = METRICS.rowH + "px";
      row.style.paddingLeft = graphWidth + "px";
    }

    function virtualRow(kind, title, sub, graphWidth, onClick) {
      var row = u.el("div", "gv-virtual-row gv-virtual-row--" + kind);
      sizeRow(row, graphWidth);
      row.appendChild(u.el("span", "gv-virtual-dot"));
      var body = u.el("div", "gv-virtual-body");
      body.appendChild(u.el("span", "gv-virtual-title", title));
      if (sub) body.appendChild(u.el("span", "gv-virtual-sub", sub));
      row.appendChild(body);
      row.addEventListener("click", onClick);
      return row;
    }

    function stashRow(st, graphWidth) {
      var row = virtualRow("stash", st.ref, st.subject, graphWidth, function () {
        document.querySelectorAll(".gv-unified-row, .gv-virtual-row").forEach(function (el) {
          el.classList.remove("gv-unified-row--selected", "gv-virtual-row--selected");
        });
        row.classList.add("gv-virtual-row--selected");
        S.currentHash = st.ref;
        detailPane.showStash(st);
        app.post("requestStashFiles", { hash: st.ref });
      });
      row.addEventListener("contextmenu", function (ev) {
        ev.preventDefault();
        menus.forStash(st, ev.clientX, ev.clientY);
      });
      return row;
    }

    /** Working-changes row (if dirty) and stash rows sit above the commits; returns how many. */
    function renderVirtualRows(payload, graphWidth) {
      var w = payload.working || { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
      var stashes = payload.stashes || [];
      var count = 0;
      if (w.staged + w.modified + w.untracked + w.conflicted > 0) {
        var work = virtualRow("working", UI.workingChanges || "Working changes", formatWorkingSummary(w), graphWidth,
          function () { app.actions.showWork(); });
        work.addEventListener("contextmenu", function (ev) {
          ev.preventDefault();
          menus.forWorking(ev.clientX, ev.clientY);
        });
        if (S.currentHash === GV.WORK_SELECTION) work.classList.add("gv-virtual-row--selected");
        root.appendChild(work);
        count++;
      }
      stashes.forEach(function (st) { root.appendChild(stashRow(st, graphWidth)); count++; });
      return count;
    }

    /**
     * The row's ref labels, grouped (local + same-named remote folded, origin/HEAD dropped) and
     * capped: overflow becomes one "+N" chip whose tooltip lists everything. The labels share at
     * most part of the row (CSS), so the commit message always keeps room.
     */
    function refChips(refs) {
      var R = GV.refChips;
      var chips = R.groupRefs(refs);
      var box = u.el("span", "gv-ref-chips");
      if (!chips.length) return box;
      var parts = R.splitInline(chips);
      parts.shown.forEach(function (c) {
        var chip = u.el("span", "gv-ref-chip gv-ref-chip--" + c.kind);
        chip.appendChild(u.el("span", "gv-ref-chip__text", c.label));
        if (c.remotes.length) {
          chip.classList.add("gv-ref-chip--synced");
          chip.appendChild(u.el("span", "gv-ref-chip__remote", "⇄"));
        }
        chip.title = R.describe(c);
        box.appendChild(chip);
      });
      if (parts.hidden.length) {
        var more = u.el("span", "gv-ref-chip gv-ref-chip--more",
          (UI.moreRefsLabel || "+{0}").replace("{0}", String(parts.hidden.length)));
        more.title = parts.hidden.map(R.describe).join("\n");
        box.appendChild(more);
      }
      box.title = chips.map(R.describe).join("\n");
      return box;
    }

    function buildCommitCell(c, color) {
      var cell = u.el("div", "gv-unified-commit");
      var left = u.el("div", "gv-row-left");
      left.appendChild(refChips(c.refs));
      var subj = u.el("span", "gv-unified-subject gv-subject", c.subject);
      subj.title = c.subject;
      left.appendChild(subj);
      var right = u.el("div", "gv-row-right");
      var author = u.el("span", "gv-author", c.author);
      author.title = c.author;
      var date = GV.display.dateText(c.dateSec);
      var when = u.el("span", "gv-time", date.text);
      when.title = date.title;
      when.setAttribute("data-sec", String(c.dateSec || 0)); // re-labelled when the date format changes
      var hash = u.el("code", "gv-hash", c.hash.slice(0, 7));
      hash.style.setProperty("--gv-hash-color", color);
      right.appendChild(author);
      right.appendChild(when);
      right.appendChild(hash);
      cell.appendChild(left);
      cell.appendChild(right);
      return cell;
    }

    function clearScrollHandler() {
      if (scrollHandler && canvas) canvas.removeEventListener("scroll", scrollHandler);
      scrollHandler = null;
    }

    function drawGraph(commits, layout, graphWidth, graphOffset) {
      if (!svg) return;
      var h = commits.length * METRICS.rowH;
      svg.setAttribute("width", String(graphWidth));
      svg.setAttribute("height", String(h));
      svg.style.width = graphWidth + "px";
      svg.style.height = h + "px";
      svg.style.top = graphOffset + "px";
      svg.textContent = "";
      var commitIndex = {};
      commits.forEach(function (c, i) { commitIndex[c.hash] = i; });
      GV.graphSvg.draw(svg, commits, layout, commitIndex, METRICS);
    }

    /** Renders commits; returns false when there is nothing to show. */
    function render(payload) {
      clearScrollHandler();
      root.innerHTML = "";
      activeList = null;
      root.removeAttribute("aria-activedescendant");
      var commits = payload.commits || [];
      if (!commits.length) {
        // No commit yet, but files to commit: show the working-changes row so the first commit can
        // be made here. Otherwise the caller shows the "no commits" card.
        var w = payload.working || {};
        if (!(w.staged || w.modified || w.untracked || w.conflicted)) return false;
        renderVirtualRows(payload, METRICS.sidePad * 2 + METRICS.laneW);
        if (svg) svg.textContent = "";
        return true;
      }

      var layout = GV.laneLayout.computeLaneLayout(commits);
      var graphWidth = Math.min(METRICS.sidePad * 2 + Math.max(1, layout.totalLanes) * METRICS.laneW, MAX_GRAPH_W);
      var graphOffset = renderVirtualRows(payload, graphWidth) * METRICS.rowH;
      drawGraph(commits, layout, graphWidth, graphOffset);
      if (canvas) canvas.style.setProperty("--gv-graph-w", graphWidth + "px");
      mountVirtualList(commits, layout, graphWidth, graphOffset, !!payload.onHeadKnown);
      return true;
    }

    function mountVirtualList(commits, layout, graphWidth, graphOffset, onHeadKnown) {
      var ROW_H = METRICS.rowH;
      var list = u.el("div", "gv-commit-list-inner");
      var topSpacer = u.el("div", "gv-spacer");
      var bottomSpacer = u.el("div", "gv-spacer");
      list.appendChild(topSpacer);
      list.appendChild(bottomSpacer);
      root.appendChild(list);
      var rendered = {}; // index → element

      var indexOfHash = {};
      commits.forEach(function (c, i) { indexOfHash[c.hash] = i; });

      /** Selects row i like a click: highlight, graph ring, detail pane. scroll: bring it into view. */
      function selectIndex(i, scroll) {
        var c = commits[i];
        if (!c) return;
        if (scroll) {
          var top = graphOffset + i * ROW_H;
          if (top < canvas.scrollTop) canvas.scrollTop = top;
          else if (top + ROW_H > canvas.scrollTop + canvas.clientHeight) canvas.scrollTop = top + ROW_H - canvas.clientHeight;
          update(); // rows are virtual: make sure row i exists before pointing at it
        }
        Object.keys(rendered).forEach(function (k) {
          rendered[k].classList.remove("gv-unified-row--selected");
          rendered[k].setAttribute("aria-selected", "false");
        });
        if (rendered[i]) {
          rendered[i].classList.add("gv-unified-row--selected");
          rendered[i].setAttribute("aria-selected", "true");
          root.setAttribute("aria-activedescendant", rendered[i].id);
        }
        GV.graphSvg.highlightNode(svg, layout.perRow[i].lane, i, METRICS);
        detailPane.showCommit(c);
      }

      function selectedIndex() {
        var i = indexOfHash[S.currentHash];
        return typeof i === "number" ? i : -1;
      }

      activeList = {
        selectIndex: selectIndex,
        selectedIndex: selectedIndex,
        count: commits.length,
        pageRows: function () { return Math.max(1, Math.floor(canvas.clientHeight / ROW_H) - 1); },
        parentIndex: function (i) { return GV.commitNav.parentIndex(commits, i, indexOfHash); },
        childIndex: function (i) { return GV.commitNav.childIndex(commits, i); },
        rowEl: function (i) { return rendered[i]; },
        commit: function (i) { return commits[i]; },
      };

      function buildRow(i) {
        var c = commits[i];
        var lane = layout.perRow[i].lane;
        var row = u.el("div", "gv-unified-row gv-commit-log-row gv-row-click");
        row.setAttribute("role", "option");
        row.id = "gv-commit-row-" + i;
        row.dataset.hash = c.hash;
        sizeRow(row, graphWidth);
        var isSel = c.hash === S.currentHash;
        row.setAttribute("aria-selected", isSel ? "true" : "false");
        if (isSel) {
          row.classList.add("gv-unified-row--selected");
          // After a refresh / next page the selected row is rebuilt: point the listbox at it again.
          root.setAttribute("aria-activedescendant", row.id);
        }
        if (S.markedHash && c.hash === S.markedHash) row.classList.add("gv-unified-row--marked");
        if (c.offHead) {
          // Dimming is visual only; screen readers get the same fact as a description.
          row.classList.add("gv-unified-row--offhead");
          row.setAttribute("aria-description", UI.commitNotOnHead || "Not on the current branch");
        } else if (onHeadKnown) {
          // On the current branch in a view that also shows others; tinted when the setting is on.
          row.classList.add("gv-unified-row--onhead");
        }
        row.appendChild(buildCommitCell(c, u.laneColor(lane)));
        row.addEventListener("click", function () {
          selectIndex(i, false);
          // Keys work right after a click: the list (not the row) holds focus, like a listbox.
          root.focus({ preventScroll: true });
        });
        row.addEventListener("contextmenu", function (ev) {
          ev.preventDefault();
          menus.forCommit(c, ev.clientX, ev.clientY);
        });
        return row;
      }

      function visibleRange() {
        var scrollTop = canvas.scrollTop;
        var viewH = canvas.clientHeight || commits.length * ROW_H;
        var start = Math.max(0, Math.floor((scrollTop - graphOffset) / ROW_H) - BUFFER);
        var end = Math.min(commits.length - 1, Math.ceil((scrollTop + viewH - graphOffset) / ROW_H) + BUFFER);
        if (end < start) { start = 0; end = Math.min(commits.length - 1, BUFFER * 2); }
        return { start: start, end: end };
      }

      function syncRows(r) {
        Object.keys(rendered).forEach(function (k) {
          if (k < r.start || k > r.end) {
            // The listbox must not point at a row that is leaving the DOM (virtual scrolling).
            if (root.getAttribute("aria-activedescendant") === rendered[k].id) root.removeAttribute("aria-activedescendant");
            list.removeChild(rendered[k]);
            delete rendered[k];
          }
        });
        topSpacer.style.height = (r.start * ROW_H) + "px";
        bottomSpacer.style.height = ((commits.length - 1 - r.end) * ROW_H) + "px";
        // Re-insert in index order, back to front, so DOM order always matches row order.
        var anchor = bottomSpacer;
        for (var i = r.end; i >= r.start; i--) {
          if (!rendered[i]) rendered[i] = buildRow(i);
          if (rendered[i].nextSibling !== anchor) list.insertBefore(rendered[i], anchor);
          anchor = rendered[i];
        }
      }

      function update() {
        if (!canvas) return;
        var r = visibleRange();
        syncRows(r);
        if (r.end >= commits.length - 1 - BUFFER) app.loadMore();
      }

      var rafScheduled = false;
      scrollHandler = function () {
        if (rafScheduled) return;
        rafScheduled = true;
        window.requestAnimationFrame(function () {
          rafScheduled = false;
          update();
        });
      };
      if (canvas) canvas.addEventListener("scroll", scrollHandler, { passive: true });
      update();
    }

    function clear() {
      clearScrollHandler();
      root.innerHTML = "";
      activeList = null;
      root.removeAttribute("aria-activedescendant");
    }

    /** Toggle the "marked for compare" style on rows currently in the DOM. */
    function refreshMarks() {
      document.querySelectorAll(".gv-unified-row").forEach(function (el) {
        el.classList.toggle("gv-unified-row--marked", !!(S.markedHash && el.dataset && el.dataset.hash === S.markedHash));
      });
    }

    return { render: render, clear: clear, refreshMarks: refreshMarks };
  };
})(window.GV = window.GV || {});
