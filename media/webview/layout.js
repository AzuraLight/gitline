// Pane layout: the branch list, the graph and the preview can each be collapsed, and the two
// splitters between them resize by drag or keyboard. Sizes and collapsed panes are remembered in
// the webview state (they survive a restart). Pure geometry lives in GV.layoutMath for the tests.
(function (GV) {
  "use strict";

  var SIDEBAR = { def: 220, min: 140 };
  var PREVIEW = { min: 180 };
  var PREVIEW_H = { min: 120 }; // details below the graph (gitline.graph.detailsLocation)
  var LOG_MIN_H = 120;          // the graph keeps at least this much height above them
  var LOG_MIN = 200;          // the graph keeps at least this much while the preview grows
  var COLLAPSED_W = 28;       // a collapsed pane is a strip with its toggle and a vertical title
  var SNAP = 60;              // dragging this far below a minimum collapses the pane
  var STEP = 16, BIG_STEP = 64;
  var MAX_SAVED_W = 4000;     // a saved width beyond any real screen is junk

  /** Keeps a pane width between its minimum and what the space next to it can give up. */
  function clamp(w, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, Math.round(w)));
  }

  function validWidth(w) {
    return typeof w === "number" && isFinite(w) && w > 0 && w <= MAX_SAVED_W;
  }

  /** Saved layout from an untrusted source (older state, hand edits) → a valid one. */
  function normalize(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var c = r.collapsed && typeof r.collapsed === "object" ? r.collapsed : {};
    var out = {
      sidebarW: validWidth(r.sidebarW) ? Math.round(r.sidebarW) : SIDEBAR.def,
      previewW: validWidth(r.previewW) ? Math.round(r.previewW) : 0, // 0 = 40 %
      previewH: validWidth(r.previewH) ? Math.round(r.previewH) : 0, // below the graph; 0 = 40 %
      collapsed: { sidebar: c.sidebar === true, log: c.log === true, preview: c.preview === true },
    };
    // The graph and the preview share one area; at least one of them stays open.
    if (out.collapsed.log && out.collapsed.preview) out.collapsed.preview = false;
    return out;
  }

  /** Collapsing `pane` may have to open its partner (graph ↔ preview). Returns the new map. */
  function toggleCollapsed(collapsed, pane) {
    var next = { sidebar: collapsed.sidebar, log: collapsed.log, preview: collapsed.preview };
    next[pane] = !next[pane];
    if (next[pane] && pane === "log") next.preview = false;
    if (next[pane] && pane === "preview") next.log = false;
    return next;
  }

  /** Below these panel widths a pane folds away by itself (VS Code does the same with its views). */
  var AUTO = { preview: 640, sidebar: 420 };
  /** Graph (240) + preview (160) + two folded strips + splitters: below this only one of them fits. */
  var BOTH_FIT = 240 + 160 + 2 * 28 + 10;
  /** Details below the graph: they fold below this panel height, and both fit from BOTH_FIT_H. */
  var AUTO_H = 300;
  var BOTH_FIT_H = 120 + 120 + 28 + 10;

  /**
   * What is actually shown: the saved choice, plus panes folded because the panel is too narrow —
   * the preview below 640 px, the branch list below 420 px — unless the user opened that pane by
   * hand since (`opened`). The graph always stays: if it was collapsed and the preview folds, the
   * graph comes back — except when the user opened the preview by hand where graph and preview
   * cannot both fit: then the preview takes the graph's place instead of overflowing the panel.
   * width 0 (not laid out yet) folds nothing. With the details below the graph (`bottom`), the
   * same rules use the panel's height instead: there the width takes nothing from the details.
   */
  function effectiveCollapsed(collapsed, width, opened, height, bottom) {
    var o = opened || {};
    var next = { sidebar: collapsed.sidebar, log: collapsed.log, preview: collapsed.preview };
    var size = bottom ? (height || 0) : width;
    var fold = bottom ? AUTO_H : AUTO.preview;
    var both = bottom ? BOTH_FIT_H : BOTH_FIT;
    if (size > 0 && size < fold && !o.preview) {
      next.preview = true;
      next.log = false;
    }
    if (width > 0 && width < AUTO.sidebar && !o.sidebar) next.sidebar = true;
    if (size > 0 && o.preview && !next.preview && size < both) next.log = true;
    return next;
  }

  GV.layoutMath = {
    clamp: clamp, normalize: normalize, toggleCollapsed: toggleCollapsed, effectiveCollapsed: effectiveCollapsed,
    AUTO: AUTO, BOTH_FIT: BOTH_FIT, AUTO_H: AUTO_H, BOTH_FIT_H: BOTH_FIT_H, SNAP: SNAP,
  };

  if (typeof document === "undefined") return; // loaded by the unit tests

  GV.createLayout = function (app) {
    var S = app.state;
    var $ = function (id) { return document.getElementById(id); };
    var root = document.querySelector(".gv-workspace-root");
    var workspace = $("graph-workspace");
    var panes = {
      sidebar: $("branch-bar"),
      log: document.querySelector('[data-pane="log"]'),
      preview: document.querySelector('[data-pane="preview"]'),
    };
    var splitSidebar = $("split-sidebar");
    var splitPreview = $("split-preview");
    var L = normalize(S.layout);
    S.layout = L;
    var opened = { sidebar: false, preview: false }; // folded by width, then opened by the user (this session)
    var shown = L.collapsed;                           // what is on screen; see effectiveCollapsed
    var bottom = false;                                // details below the graph (detailsLocation)

    function workspaceH() { return workspace ? workspace.clientHeight : 0; }
    function previewMaxH() {
      var h = workspaceH();
      return h ? h - LOG_MIN_H : 2000;
    }
    function currentPreviewH() {
      return L.previewH || (panes.preview ? panes.preview.getBoundingClientRect().height : 0) || 240;
    }
    /** The details pane's size along the split: width beside the graph, height below it. */
    function previewSize() {
      return bottom ? clamp(currentPreviewH(), PREVIEW_H.min, previewMaxH()) : clamp(currentPreviewW(), PREVIEW.min, previewMax());
    }

    function previewMax() {
      var w = workspace ? workspace.clientWidth : 0;
      return w ? w - LOG_MIN : 2000;
    }
    function sidebarMax() {
      var w = root ? root.clientWidth : 0;
      return w ? Math.max(SIDEBAR.min, Math.floor(w * 0.6)) : 600;
    }
    function currentPreviewW() {
      return L.previewW || (panes.preview ? panes.preview.getBoundingClientRect().width : 0) || 360;
    }

    function setSeparator(el, now, min, max, enabled) {
      if (!el) return;
      el.setAttribute("aria-valuenow", String(now));
      el.setAttribute("aria-valuemin", String(min));
      el.setAttribute("aria-valuemax", String(max));
      el.classList.toggle("gv-splitter--disabled", !enabled);
      el.setAttribute("aria-disabled", enabled ? "false" : "true");
    }

    function apply() {
      var width = root ? root.clientWidth : 0;
      var height = root ? root.clientHeight : 0;
      var where = GV.display ? GV.display.get().detailsLocation : "auto";
      // The graph area's height (below the toolbar) decides both placing and folding the details.
      var nowBottom = GV.displayMath ? GV.displayMath.resolveLocation(where, width, workspaceH() || height) === "bottom" : false;
      if (nowBottom !== bottom) opened.preview = false; // a fold override belongs to one arrangement
      bottom = nowBottom;
      if (workspace) workspace.classList.toggle("gv-details-bottom", bottom);
      if (splitPreview) splitPreview.setAttribute("aria-orientation", bottom ? "horizontal" : "vertical");
      // Big enough again: forget the hand-opened overrides, the panel no longer folds them.
      if (bottom ? height >= AUTO_H : width >= AUTO.preview) opened.preview = false;
      if (width >= AUTO.sidebar) opened.sidebar = false;
      shown = effectiveCollapsed(L.collapsed, width, opened, workspaceH() || height, bottom);
      if (root) {
        root.style.setProperty("--gv-sidebar-w", clamp(L.sidebarW, SIDEBAR.min, sidebarMax()) + "px");
        root.style.setProperty("--gv-preview-w", L.previewW ? clamp(L.previewW, PREVIEW.min, previewMax()) + "px" : "40%");
        root.style.setProperty("--gv-preview-h", L.previewH ? clamp(L.previewH, PREVIEW_H.min, previewMaxH()) + "px" : "40%");
        root.style.setProperty("--gv-collapsed-w", COLLAPSED_W + "px");
      }
      Object.keys(panes).forEach(function (name) {
        var el = panes[name];
        if (!el) return;
        var shut = shown[name];
        el.classList.toggle("gv-collapsed", shut);
        var btn = el.querySelector("[data-pane-toggle]");
        if (btn) btn.setAttribute("aria-expanded", shut ? "false" : "true");
      });
      // A splitter next to a collapsed pane still works: dragging it out reopens the pane (as in
      // VS Code). Only the preview splitter with the graph collapsed has nothing to do.
      // Report what is on screen (clamped to the space available), not the raw saved number.
      setSeparator(splitSidebar, shown.sidebar ? COLLAPSED_W : clamp(L.sidebarW, SIDEBAR.min, sidebarMax()),
        SIDEBAR.min, sidebarMax(), true);
      setSeparator(splitPreview, shown.preview ? COLLAPSED_W : previewSize(),
        bottom ? PREVIEW_H.min : PREVIEW.min, bottom ? previewMaxH() : previewMax(),
        !shown.log);
    }

    function save() {
      S.layout = L;
      app.saveState();
    }

    /** Opens or shuts a pane as the user sees it. A pane folded by width is opened for the session
     *  (the saved choice stays); otherwise the saved choice flips. */
    function setShown(pane, open) {
      if (open && shown[pane] && !L.collapsed[pane] && (pane === "sidebar" || pane === "preview")) {
        opened[pane] = true;
      } else if (!open && !shown[pane] && opened[pane]) {
        opened[pane] = false;
      } else if (open === !!L.collapsed[pane]) {
        L.collapsed = toggleCollapsed(L.collapsed, pane);
        if (open && (pane === "sidebar" || pane === "preview")) opened[pane] = true;
        // Shutting the graph while the preview is folded by width: the preview takes its place.
        if (!open && pane === "log") opened.preview = true;
      }
    }

    function toggle(pane) {
      setShown(pane, !!shown[pane]);
      apply();
      save();
    }

    // ---- Splitters: drag, keyboard, double-click ----------------------------------------------

    /** which: "sidebar" grows to the right, "preview" grows to the left. */
    function resizeBy(which, startW, dx) {
      if (which === "sidebar") {
        var sw = startW + dx;
        if (sw < SIDEBAR.min - SNAP) {
          if (!shown.sidebar) setShown("sidebar", false);
          return;
        }
        if (shown.sidebar) setShown("sidebar", true);
        L.sidebarW = clamp(sw, SIDEBAR.min, sidebarMax());
      } else {
        var pw = startW - dx;
        var min = bottom ? PREVIEW_H.min : PREVIEW.min;
        if (pw < min - SNAP) {
          if (!shown.preview) setShown("preview", false);
          return;
        }
        if (shown.preview) setShown("preview", true);
        if (bottom) L.previewH = clamp(pw, PREVIEW_H.min, previewMaxH());
        else L.previewW = clamp(pw, PREVIEW.min, previewMax());
      }
    }

    function wireSplitter(el, which) {
      if (!el) return;
      el.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        if (which === "preview" && shown.log) return;
        ev.preventDefault();
        // Details below the graph: the splitter moves up and down instead.
        var vertical = which === "preview" && bottom;
        var startX = vertical ? ev.clientY : ev.clientX;
        var startW = which === "sidebar" ? (shown.sidebar ? COLLAPSED_W : L.sidebarW) : (bottom ? currentPreviewH() : currentPreviewW());
        if (which === "preview" && shown.preview) startW = COLLAPSED_W;
        el.setPointerCapture(ev.pointerId);
        el.classList.add("gv-splitter--dragging");
        document.body.classList.add(vertical ? "gv-resizing-rows" : "gv-resizing");
        function move(e) {
          resizeBy(which, startW, (vertical ? e.clientY : e.clientX) - startX);
          apply();
        }
        var ended = false;
        function up() {
          if (ended) return;
          ended = true;
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          el.removeEventListener("lostpointercapture", up);
          el.classList.remove("gv-splitter--dragging");
          document.body.classList.remove("gv-resizing", "gv-resizing-rows");
          save();
        }
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        // Focus leaving the webview mid-drag releases the capture without a pointerup.
        el.addEventListener("lostpointercapture", up);
      });
      el.addEventListener("dblclick", function () {
        if (which === "sidebar") L.sidebarW = SIDEBAR.def;
        else if (bottom) L.previewH = 0;
        else L.previewW = 0;
        apply();
        save();
      });
      el.addEventListener("keydown", function (ev) {
        if (el.getAttribute("aria-disabled") === "true") return;
        var step = ev.shiftKey ? BIG_STEP : STEP;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle(which === "sidebar" ? "sidebar" : "preview");
          return;
        }
        var vertical = which === "preview" && bottom;
        var less = vertical ? "ArrowUp" : "ArrowLeft", more = vertical ? "ArrowDown" : "ArrowRight";
        if (ev.key !== less && ev.key !== more) return;
        if (which === "preview" && (shown.log || shown.preview)) return;
        if (which === "sidebar" && shown.sidebar) return;
        ev.preventDefault();
        var dx = ev.key === more ? step : -step;
        // Keyboard steps never snap-collapse; Enter does that explicitly.
        if (which === "sidebar") L.sidebarW = clamp(L.sidebarW + dx, SIDEBAR.min, sidebarMax());
        else if (vertical) L.previewH = clamp(currentPreviewH() - dx, PREVIEW_H.min, previewMaxH());
        else L.previewW = clamp(currentPreviewW() - dx, PREVIEW.min, previewMax());
        apply();
        save();
      });
    }

    wireSplitter(splitSidebar, "sidebar");
    wireSplitter(splitPreview, "preview");
    Array.prototype.forEach.call(document.querySelectorAll("[data-pane-toggle]"), function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        toggle(btn.getAttribute("data-pane-toggle"));
      });
    });
    // A collapsed strip opens on a click anywhere on it, not just on the small toggle.
    Object.keys(panes).forEach(function (name) {
      var el = panes[name];
      if (!el) return;
      el.addEventListener("click", function (ev) {
        if (shown[name] && !ev.target.closest("[data-pane-toggle]")) toggle(name);
      });
    });
    window.addEventListener("resize", apply);
    // The available width also changes without a window resize — the branch list appears with the
    // first graph reply, a pane collapses — and a saved width must be re-clamped to it, or a layout
    // saved in a wide window leaves the graph a sliver in a narrow one.
    if (typeof ResizeObserver !== "undefined") {
      var pending = false;
      var ro = new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(function () { pending = false; apply(); });
      });
      if (root) ro.observe(root);
      if (workspace) ro.observe(workspace);
    }
    if (GV.display) GV.display.onChange(apply); // detailsLocation changed in settings
    apply();

    return { apply: apply, toggle: toggle, state: function () { return L; } };
  };
})(typeof window !== "undefined" ? (window.GV = window.GV || {}) : (module.exports = {}));
