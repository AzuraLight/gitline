// Shared helpers for the Gitline webview. Loaded first; every other module reads GV.util.
(function (GV) {
  "use strict";

  var LANE_PALETTE = [
    "#6cb6ff", "#f0883e", "#a5d6a7", "#d2a8ff", "#ffb86c",
    "#7ee787", "#ff7b72", "#79c0ff", "#e6a4d4", "#f1c40f",
    "#56d4dd", "#bc8cff"
  ];

  function laneColor(idx) {
    return LANE_PALETTE[idx % LANE_PALETTE.length];
  }

  /** Escapes text for use inside HTML text and double-quoted attributes. */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  /** [unit, seconds per unit] from largest to smallest, as the relative time is rounded down. */
  var REL_UNITS = [["year", 86400 * 365], ["month", 86400 * 30], ["day", 86400], ["hour", 3600], ["minute", 60]];
  var relFormatters = {};

  /** The webview's UI language (the shell sets <html lang> from VS Code's display language). */
  function uiLang() {
    var l = typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "";
    return l || "en";
  }

  /**
   * "6m ago" / "6분 전" / "6分前": relative time in the UI language. The narrow style keeps English
   * exactly as before; without Intl.RelativeTimeFormat it falls back to that English.
   */
  function formatTime(sec, lang, nowSec) {
    if (!sec) return "";
    var now = typeof nowSec === "number" ? nowSec : Date.now() / 1000;
    var diff = Math.max(0, Math.floor(now - sec));
    var unit = null, value = 0;
    for (var i = 0; i < REL_UNITS.length; i++) {
      if (diff >= REL_UNITS[i][1]) {
        unit = REL_UNITS[i][0];
        value = Math.floor(diff / REL_UNITS[i][1]);
        break;
      }
    }
    var locale = lang || uiLang();
    var Rtf = typeof Intl !== "undefined" ? Intl.RelativeTimeFormat : undefined;
    if (Rtf) {
      try {
        // Words only where they read better: "now", "yesterday". Elsewhere numbers — "auto" would
        // also give "last mo." / "last yr.", which is vaguer than "1mo ago".
        var numeric = !unit || unit === "day" ? "auto" : "always";
        var key = locale + "|" + numeric;
        var f = relFormatters[key] || (relFormatters[key] = new Rtf(locale, { numeric: numeric, style: "narrow" }));
        return unit ? f.format(-value, unit) : f.format(0, "second");
      } catch (e) {
        // unknown locale tag: fall through to English
      }
    }
    if (!unit) return "just now";
    var short = { year: "y", month: "mo", day: "d", hour: "h", minute: "m" }[unit];
    return value + short + " ago";
  }

  function formatTimeFull(sec) {
    if (!sec) return "";
    try {
      return new Date(sec * 1000).toLocaleString(uiLang());
    } catch (e) {
      return new Date(sec * 1000).toLocaleString();
    }
  }

  function baseName(p) {
    var parts = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p || "");
  }

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute("hidden", "");
    else el.removeAttribute("hidden");
  }

  /** document.createElement + className + textContent in one call. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Replaces a list's content with one muted message row (empty / error states). */
  function showListMessage(listId, message) {
    var list = document.getElementById(listId);
    if (!list) return;
    list.textContent = "";
    list.appendChild(el("li", "gv-detail-files-empty", message));
  }

  /**
   * How many commits to ask for when the list scrolls to its end. Pages of `page` at first; past
   * 1,000 the steps follow the host's read-ahead (5,000 / 10,000 / 20,000 / 50,000), because every
   * page re-sends and re-draws the whole list — 250 trips of 200 to reach 50,000 cost ~50 s of
   * main-thread work (1.10.0 review). Each step is one read on the host.
   */
  var LIMIT_STEPS = [5000, 10000, 20000, 50000];
  function nextLimit(limit, page) {
    if (limit < 1000) return limit + page;
    for (var i = 0; i < LIMIT_STEPS.length; i++) if (LIMIT_STEPS[i] > limit) return LIMIT_STEPS[i];
    return limit + page;
  }

  GV.util = {
    nextLimit: nextLimit,
    laneColor: laneColor,
    esc: esc,
    formatTime: formatTime,
    formatTimeFull: formatTimeFull,
    baseName: baseName,
    setHidden: setHidden,
    el: el,
    showListMessage: showListMessage,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = GV.util; // unit tests
})(typeof window !== "undefined" ? (window.GV = window.GV || {}) : {});
