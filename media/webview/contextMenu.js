// Right-click menu. items: array of { label, run, danger? } or "-" for a separator.
(function (GV) {
  "use strict";
  var ctxEl = document.getElementById("ctx-menu");

  function hide() {
    if (!ctxEl) return;
    ctxEl.hidden = true;
    ctxEl.textContent = "";
  }

  function buildItem(it) {
    if (it === "-") return GV.util.el("div", "gv-ctx__sep");
    var btn = GV.util.el("button", "gv-ctx__item" + (it.danger ? " gv-ctx__item--danger" : ""), it.label);
    btn.type = "button";
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      hide();
      it.run();
    });
    return btn;
  }

  function clampToViewport() {
    var rect = ctxEl.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (rect.right > vw) ctxEl.style.left = Math.max(4, vw - rect.width - 4) + "px";
    if (rect.bottom > vh) ctxEl.style.top = Math.max(4, vh - rect.height - 4) + "px";
  }

  function show(x, y, items) {
    if (!ctxEl) return;
    ctxEl.textContent = "";
    items.forEach(function (it) { ctxEl.appendChild(buildItem(it)); });
    ctxEl.hidden = false;
    ctxEl.style.left = x + "px";
    ctxEl.style.top = y + "px";
    clampToViewport();
  }

  document.addEventListener("click", function (e) {
    if (ctxEl && !ctxEl.hidden && !ctxEl.contains(e.target)) hide();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("blur", hide);

  GV.contextMenu = { show: show, hide: hide };
})(window.GV = window.GV || {});
