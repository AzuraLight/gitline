// Draws the lane graph (edges + nodes) into the #graph-svg element.
(function (GV) {
  "use strict";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var laneColor = GV.util.laneColor;

  /** Geometry shared by drawing and the selection ring. */
  function geometry(m) {
    return {
      laneX: function (idx) { return m.sidePad + idx * m.laneW + m.laneW / 2; },
      rowY: function (idx) { return idx * m.rowH + m.rowH / 2; },
    };
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
    return node;
  }

  function pathCurve(x1, y1, x2, y2) {
    if (x1 === x2) return "M " + x1 + " " + y1 + " L " + x2 + " " + y2;
    var midY = (y1 + y2) / 2;
    return "M " + x1 + " " + y1 + " C " + x1 + " " + midY + ", " + x2 + " " + midY + ", " + x2 + " " + y2;
  }

  function addPath(svg, d, color, opacity, dashed) {
    var attrs = { d: d, stroke: color, "stroke-width": 2, "stroke-linecap": "round", fill: "none" };
    if (opacity != null) attrs.opacity = opacity;
    if (dashed) attrs["stroke-dasharray"] = "3 4";
    svg.appendChild(svgEl("path", attrs));
  }

  /**
   * Lanes alive above and below a row that are not the row's own commit, plus every lane that
   * was waiting for this row's commit: those run from the row's top edge into its node (a fork
   * point has one per child branch, each in that branch's colour).
   */
  function drawPassthroughs(svg, commits, layout, g, m, from, to) {
    for (var i = from; i <= to; i++) {
      var lp = layout.perRow[i];
      var cy = g.rowY(i);
      for (var L = 0; L < lp.before.length; L++) {
        var hash = lp.before[L];
        if (!hash) continue;
        if (hash === commits[i].hash) {
          addPath(svg, pathCurve(g.laneX(L), cy - m.rowH / 2, g.laneX(lp.lane), cy), laneColor(L), 0.95);
          continue;
        }
        var newL = GV.laneLayout.passthroughTarget(lp, L);
        if (newL === -1) continue;
        addPath(svg, pathCurve(g.laneX(L), cy - m.rowH / 2, g.laneX(newL), cy + m.rowH / 2), laneColor(newL), 0.85);
      }
    }
  }

  /** Each commit → its parents' lanes on the next row, dashed when the parent is not loaded. */
  function drawParentEdges(svg, commits, layout, commitIndex, g, m, from, to) {
    for (var i = from; i <= to; i++) {
      var lp = layout.perRow[i];
      var cx = g.laneX(lp.lane);
      var cy = g.rowY(i);
      var parents = commits[i].parents || [];
      for (var pi = 0; pi < parents.length; pi++) {
        var pLane = lp.parentLanes[pi];
        if (pLane == null) continue;
        var px = g.laneX(pLane);
        var step = pathCurve(cx, cy, px, cy + m.rowH / 2);
        if (commitIndex[parents[pi]] == null) {
          addPath(svg, step, laneColor(pLane), 0.6, true);
        } else {
          addPath(svg, step, laneColor(pLane), 0.95);
        }
      }
    }
  }

  /**
   * The dashed run from a commit whose parent is not loaded down to the end of the list, drawn
   * for rows from..to only. In a file's history nearly every commit has such a run (its parent
   * changed other files): 4,478 of 4,959 rows for VS Code's package.json. Runs in one lane share
   * its colour and line, so each lane gets one run, from the first that starts at or above `to`.
   */
  function drawTails(svg, commits, layout, commitIndex, g, m, from, to) {
    var firstStart = {}; // lane → row of the earliest run in it
    for (var i = 0; i <= to; i++) {
      var parents = commits[i].parents || [];
      for (var pi = 0; pi < parents.length; pi++) {
        var pLane = layout.perRow[i].parentLanes[pi];
        if (pLane == null || commitIndex[parents[pi]] != null) continue;
        if (!(pLane in firstStart)) firstStart[pLane] = i;
      }
    }
    var top = from * m.rowH;
    var bottom = to === commits.length - 1 ? commits.length * m.rowH + m.rowH / 2 : (to + 1) * m.rowH;
    for (var lane in firstStart) {
      var startY = Math.max(g.rowY(firstStart[lane]) + m.rowH / 2, top);
      if (startY >= bottom) continue;
      var px = g.laneX(Number(lane));
      addPath(svg, "M " + px + " " + startY + " L " + px + " " + bottom, laneColor(Number(lane)), 0.6, true);
    }
  }

  function drawNodes(svg, commits, layout, g, m, from, to) {
    for (var i = from; i <= to; i++) {
      var lane = layout.perRow[i].lane;
      var color = laneColor(lane);
      var cx = g.laneX(lane), cy = g.rowY(i);
      var off = !!commits[i].offHead; // not on HEAD: the node fades with its row's text
      svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: m.nodeR + 3, fill: color, opacity: off ? "0.08" : "0.18" }));
      var node = {
        cx: cx, cy: cy, r: m.nodeR, fill: color,
        stroke: "var(--vscode-editor-background)", "stroke-width": 2,
      };
      if (off) node["fill-opacity"] = "0.45";
      svg.appendChild(svgEl("circle", node));
    }
  }

  function layer(svg, cls) {
    var el = svg.querySelector("g." + cls);
    if (!el) {
      el = svgEl("g", { class: cls });
      // Below the selection ring, which is appended to the svg itself.
      svg.insertBefore(el, svg.querySelector(".gv-node-selected"));
    }
    return el;
  }

  /**
   * Starts a fresh drawing. Rows are drawn by drawRows, only the ones near the viewport — with
   * thousands of rows, drawing every one stalled the panel (1.10.0: 5,000 rows took 1.8 s to draw
   * and lay out).
   */
  function draw(svg) {
    svg.textContent = "";
    layer(svg, "gv-graph-rows");
  }

  /** Draws rows from..to (inclusive), replacing the rows drawn before. m = { rowH, laneW, nodeR, sidePad } */
  function drawRows(svg, commits, layout, commitIndex, m, from, to) {
    var rows = layer(svg, "gv-graph-rows");
    rows.textContent = "";
    from = Math.max(0, from);
    to = Math.min(commits.length - 1, to);
    if (to < from) return;
    var g = geometry(m);
    // Built off-document, then attached once.
    var frag = svgEl("g", {});
    drawTails(frag, commits, layout, commitIndex, g, m, from, to);
    drawPassthroughs(frag, commits, layout, g, m, from, to);
    drawParentEdges(frag, commits, layout, commitIndex, g, m, from, to);
    drawNodes(frag, commits, layout, g, m, from, to);
    while (frag.firstChild) rows.appendChild(frag.firstChild);
  }

  function highlightNode(svg, lane, rowIdx, m) {
    if (!svg) return;
    var prev = svg.querySelector(".gv-node-selected");
    if (prev) prev.parentNode.removeChild(prev);
    var g = geometry(m);
    svg.appendChild(svgEl("circle", {
      class: "gv-node-selected", cx: g.laneX(lane), cy: g.rowY(rowIdx), r: m.nodeR + 5,
      fill: "none", stroke: "var(--vscode-focusBorder)", "stroke-width": 2,
    }));
  }

  GV.graphSvg = { draw: draw, drawRows: drawRows, highlightNode: highlightNode };
})(window.GV = window.GV || {});
