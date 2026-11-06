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

  return { computeLaneLayout: computeLaneLayout };
});
