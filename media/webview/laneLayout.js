// Pure lane assignment for the commit graph. No DOM — also loaded by the unit tests under Node.
(function (factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (window.GV = window.GV || {}).laneLayout = api;
})(function () {
  "use strict";

  /**
   * Walks commits newest → oldest and gives each one a lane (column).
   * perRow[i] = { lane, before, after, parentLanes } where before/after are the lane → hash
   * slots alive above and below row i. totalLanes is the widest point of the graph.
   */
  function computeLaneLayout(commits) {
    var lanes = [];
    var perRow = [];
    var maxLanes = 0;
    function emptySlot() {
      for (var i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
      lanes.push(null);
      return lanes.length - 1;
    }
    for (var i = 0; i < commits.length; i++) {
      var c = commits[i];
      var before = lanes.slice();
      var myLane = lanes.indexOf(c.hash);
      if (myLane === -1) myLane = emptySlot();
      // A commit can be awaited in several lanes (a fork point: each child branch reserved a
      // lane for it). All of them converge into this node and are freed here — otherwise the
      // extra lane stays reserved forever and draws a phantom line down the rest of the graph.
      for (var k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null;
      var parentLanes = [];
      var parents = c.parents || [];
      for (var p = 0; p < parents.length; p++) {
        var par = parents[p];
        if (p === 0) {
          lanes[myLane] = par;
          parentLanes.push(myLane);
        } else {
          var existing = lanes.indexOf(par);
          if (existing === -1) {
            var ns = emptySlot();
            lanes[ns] = par;
            parentLanes.push(ns);
          } else {
            parentLanes.push(existing);
          }
        }
      }
      // Compact trailing nulls so lane count stays minimal.
      while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
      var after = lanes.slice();
      perRow.push({ lane: myLane, before: before, after: after, parentLanes: parentLanes });
      if (before.length > maxLanes) maxLanes = before.length;
      if (after.length > maxLanes) maxLanes = after.length;
      if (myLane + 1 > maxLanes) maxLanes = myLane + 1;
    }
    return { perRow: perRow, totalLanes: maxLanes };
  }

  /**
   * Where lane L of row `row` continues below it, or -1 if it ends there. Several lanes can await
   * the same commit (two children of one parent), so a lane that is still alive keeps its own
   * column instead of jumping to the first lane with the same hash.
   */
  function passthroughTarget(row, L) {
    var hash = row.before[L];
    if (!hash) return -1;
    if (row.after[L] === hash) return L;
    return row.after.indexOf(hash);
  }

  var LANE_W = 14;      // a lane's width when the graph fits
  var MIN_LANE_W = 6;   // narrowest lanes before the graph is cut
  var SIDE_PAD = 10;
  var SHARE = 0.4;      // the graph takes at most this much of the list's width
  var FALLBACK_LIMIT = 220; // list not laid out yet (width 0)

  /**
   * How the graph fits the list (1.11.0). Large histories run 40–280 lanes wide (VS Code, git), and
   * a fixed 220 px cap hid 10–64% of the commit nodes. In order: up to SHARE of the list's width;
   * then narrower lanes, down to MIN_LANE_W; then the graph is cut, and lanes from `edgeLane` on are
   * drawn in one edge column (their commits as hollow nodes, a dotted line marking the cut).
   * Returns { laneW, nodeR, sidePad, columns, edgeLane (-1: nothing cut), width }.
   */
  function fitLanes(totalLanes, listWidth) {
    var lanes = Math.max(1, totalLanes);
    var limit = listWidth > 0 ? Math.floor(listWidth * SHARE) : FALLBACK_LIMIT;
    // Not even one 6 px lane fits in the share: no graph at all, the text keeps the whole row.
    if (limit < MIN_LANE_W) {
      return { laneW: MIN_LANE_W, nodeR: 2, sidePad: 0, columns: 1, edgeLane: lanes > 1 ? 0 : -1, width: 0 };
    }
    var pad = SIDE_PAD;
    // A list so narrow that even one 6 px column and the side padding pass the limit: less
    // padding, then a thinner column, so the graph never takes more than its share (1.11.0 review).
    if (limit < pad * 2 + MIN_LANE_W) pad = Math.max(0, Math.floor((limit - MIN_LANE_W) / 2));
    var avail = limit - pad * 2; // >= MIN_LANE_W: the padding gave way above
    var laneW = LANE_W, columns = lanes, edgeLane = -1;
    if (lanes * LANE_W > avail) {
      laneW = Math.floor(avail / lanes);
      if (laneW < MIN_LANE_W) {
        laneW = Math.min(MIN_LANE_W, avail);
        columns = Math.max(1, Math.floor(avail / laneW));
        if (columns < lanes) edgeLane = columns - 1;
        else columns = lanes;
      }
    }
    var nodeR = Math.max(2, Math.min(5, Math.round(laneW * 0.36)));
    return { laneW: laneW, nodeR: nodeR, sidePad: pad, columns: columns, edgeLane: edgeLane, width: pad * 2 + columns * laneW };
  }

  return { computeLaneLayout: computeLaneLayout, passthroughTarget: passthroughTarget, fitLanes: fitLanes };
});
