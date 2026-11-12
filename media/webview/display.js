// Display settings from `gitline.graph.*`: which right-hand columns show, relative or absolute
// dates, where the commit details sit, the current-branch row tint and where messages start. They only change how rows
// look, so applying them never asks git again. Pure parts live in GV.displayMath for the tests.
(function (GV) {
  "use strict";

  var COLUMNS = ["author", "date", "sha"];
  var DEFAULTS = {
    columns: { author: true, date: true, sha: true },
    dateFormat: "relative",
    detailsLocation: "auto",
    highlightCurrentBranch: false,
    messageAlignment: "lane",
  };

  /** Settings from an untrusted source (settings.json hand edits) → a valid set. */
  function normalize(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var c = r.columns && typeof r.columns === "object" && !Array.isArray(r.columns) ? r.columns : {};
    var columns = {};
    COLUMNS.forEach(function (k) { columns[k] = c[k] !== false; }); // only an explicit false hides
    return {
      columns: columns,
      dateFormat: r.dateFormat === "absolute" ? "absolute" : "relative",
      detailsLocation: r.detailsLocation === "right" || r.detailsLocation === "bottom" ? r.detailsLocation : "auto",
      highlightCurrentBranch: r.highlightCurrentBranch === true,
      // "lane": each message right after its own row's lanes (#5); "column": all after the widest point.
      messageAlignment: r.messageAlignment === "column" ? "column" : "lane",
    };
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  /** "2026-11-11 14:05" in local time: sorts and compares at a glance, the same in every language. */
  function formatAbsolute(sec) {
    if (!sec) return "";
    var d = new Date(sec * 1000);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /** Row text and tooltip for a commit date: the chosen format shows, the other one hovers. */
  function dateText(sec, format, util) {
    var rel = util ? util.formatTime(sec) : "";
    var full = util ? util.formatTimeFull(sec) : "";
    if (format === "absolute") return { text: formatAbsolute(sec), title: rel ? rel + " · " + full : full };
    return { text: rel, title: full };
  }

  /**
   * Where the details go. "auto" puts them below the graph when the panel is narrow (under 640 px,
   * where the right-hand preview would fold away) and the graph area is tall enough (300 px, the
   * height below which the details fold anyway). Size 0 (not laid out) → right.
   */
  function resolveLocation(location, width, height) {
    if (location === "right" || location === "bottom") return location;
    if (width > 0 && height > 0 && width < 640 && height >= 300) return "bottom";
    return "right";
  }

  /** The `columns` value after the user toggles one (all three may be hidden: the message stays). */
  function toggleColumn(columns, key) {
    var next = {};
    COLUMNS.forEach(function (k) { next[k] = columns[k] !== false; });
    if (COLUMNS.indexOf(key) >= 0) next[key] = !next[key];
    return next;
  }

  GV.displayMath = {
    COLUMNS: COLUMNS, DEFAULTS: DEFAULTS,
    normalize: normalize, formatAbsolute: formatAbsolute, dateText: dateText,
    resolveLocation: resolveLocation, toggleColumn: toggleColumn,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = GV.displayMath; // unit tests
  if (typeof document === "undefined") return;

  var current = normalize(typeof window !== "undefined" && window.__GV_PREFS__ ? window.__GV_PREFS__.display : null);
  var listeners = [];

  /** Classes on the shell; CSS does the hiding and the tint, so virtual rows built later match. */
  function applyClasses() {
    var shell = document.querySelector(".gv-shell") || document.body;
    COLUMNS.forEach(function (k) { shell.classList.toggle("gv-hide-col-" + k, !current.columns[k]); });
    shell.classList.toggle("gv-highlight-head", current.highlightCurrentBranch);
  }

  /** Re-labels the date cells already on screen (the virtual list builds new ones with `current`). */
  function refreshDates() {
    Array.prototype.forEach.call(document.querySelectorAll(".gv-time[data-sec]"), function (el) {
      var t = dateText(Number(el.getAttribute("data-sec")), current.dateFormat, GV.util);
      el.textContent = t.text;
      el.title = t.title;
    });
  }

  function set(raw) {
    var next = normalize(raw);
    var datesChanged = next.dateFormat !== current.dateFormat;
    current = next;
    applyClasses();
    if (datesChanged) refreshDates();
    listeners.forEach(function (fn) { fn(current); });
  }

  GV.display = {
    get: function () { return current; },
    set: set,
    onChange: function (fn) { listeners.push(fn); },
    dateText: function (sec) { return dateText(sec, current.dateFormat, GV.util); },
  };
  applyClasses();
})(typeof window !== "undefined" ? (window.GV = window.GV || {}) : {});
