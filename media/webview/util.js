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

  function formatTime(sec) {
    if (!sec) return "";
    var diff = Math.floor(Date.now() / 1000 - sec);
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + "d ago";
    if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + "mo ago";
    return Math.floor(diff / (86400 * 365)) + "y ago";
  }

  function formatTimeFull(sec) {
    if (!sec) return "";
    return new Date(sec * 1000).toLocaleString();
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

  GV.util = {
    LANE_PALETTE: LANE_PALETTE,
    laneColor: laneColor,
    esc: esc,
    formatTime: formatTime,
    formatTimeFull: formatTimeFull,
    baseName: baseName,
    setHidden: setHidden,
    el: el,
    showListMessage: showListMessage,
  };
})(window.GV = window.GV || {});
