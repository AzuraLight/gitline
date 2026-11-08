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
  function drawPassthroughs(svg, commits, layout, g, m) {
    for (var i = 0; i < commits.length; i++) {
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

  /** Each commit → its parents' lanes on the next row; a dashed tail when the parent is not loaded. */
  function drawParentEdges(svg, commits, layout, commitIndex, g, m) {
    for (var i = 0; i < commits.length; i++) {
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
          var endY = commits.length * m.rowH + m.rowH / 2;
          addPath(svg, step + " M " + px + " " + (cy + m.rowH / 2) + " L " + px + " " + endY, laneColor(pLane), 0.6, true);
        } else {
          addPath(svg, step, laneColor(pLane), 0.95);
        }
      }
    }
  }

  function drawNodes(svg, commits, layout, g, m) {
    for (var i = 0; i < commits.length; i++) {
      var lane = layout.perRow[i].lane;
      var color = laneColor(lane);
      var cx = g.laneX(lane), cy = g.rowY(i);
      svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: m.nodeR + 3, fill: color, opacity: "0.18" }));
      svg.appendChild(svgEl("circle", {
        cx: cx, cy: cy, r: m.nodeR, fill: color,
        stroke: "var(--vscode-editor-background)", "stroke-width": 2,
      }));
    }
  }

  /** m = { rowH, laneW, nodeR, sidePad } */
  function draw(svg, commits, layout, commitIndex, m) {
    var g = geometry(m);
    drawPassthroughs(svg, commits, layout, g, m);
    drawParentEdges(svg, commits, layout, commitIndex, g, m);
    drawNodes(svg, commits, layout, g, m);
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

  GV.graphSvg = { draw: draw, highlightNode: highlightNode };
})(window.GV = window.GV || {});
