// Stands in for the extension host so the real webview runs in a plain browser (README demos).
// Defines acquireVsCodeApi() and answers the webview's requests with a made-up repository.
(function () {
  "use strict";

  // ---- A small, believable history --------------------------------------------------------
  var AUTHORS = ["Mina Park", "Daniel Cho", "Sara Lee", "Jun Kim"];
  var NOW = Math.floor(Date.UTC(2026, 10, 5, 9, 0, 0) / 1000);
  var commits = [];       // oldest first while building; each { hash, parents, subject, author, dateSec, refs }
  var tips = {};          // branch → hash
  var seq = 0;

  function hashFor(n) {
    var h = (n * 2654435761 >>> 0).toString(16);
    var s = "";
    while (s.length < 40) s += h;
    return s.slice(0, 40);
  }

  function commit(branch, subject, extraParent) {
    seq++;
    var parents = tips[branch] ? [tips[branch]] : [];
    if (extraParent) parents.push(extraParent);
    var c = { hash: hashFor(seq), parents: parents, subject: subject, author: AUTHORS[seq % AUTHORS.length],
              dateSec: NOW - (200 - seq) * 5400, refs: [] };
    commits.push(c);
    tips[branch] = c.hash;
    return c;
  }

  function branchFrom(branch, from) { tips[branch] = tips[from]; }
  function merge(into, from, subject) { commit(into, subject || "Merge branch '" + from + "'", tips[from]); }

  commit("main", "Initial project skeleton");
  commit("main", "Add product catalogue API");
  commit("main", "Set up CI with unit tests");
  // Older, linear history below the interesting part — gives the list something to scroll through.
  for (var i = 0; i < 40; i++) commit("main", ["Refactor", "Tidy", "Speed up", "Test"][i % 4] + " " +
    ["order repository", "price formatter", "image uploads", "session cache", "email templates"][i % 5]);
  branchFrom("feature/checkout", "main");
  commit("feature/checkout", "Add checkout service");
  commit("main", "Bump Spring Boot to 3.3.5");
  commit("feature/checkout", "Validate shipping address");
  commit("feature/checkout", "Add payment gateway adapter");
  branchFrom("fix/cart-total", "main");
  commit("fix/cart-total", "Fix rounding in cart total");
  commit("main", "Document local setup in README");
  commit("fix/cart-total", "Cover discounts in CartTotal tests");
  merge("main", "fix/cart-total");
  commit("feature/checkout", "Show order summary before payment");
  merge("main", "feature/checkout");
  commit("main", "Release 1.4.0");
  var releaseHash = tips.main;
  branchFrom("feature/search", "main");
  commit("feature/search", "Add search index for products");
  commit("main", "Log slow queries over 200 ms");
  commit("feature/search", "Rank results by popularity");
  commit("main", "Fix 한글 product names in invoices");
  commit("feature/search", "Highlight matched words");
  commit("main", "Tighten CORS for the admin API");
  commits.reverse(); // newest first, as git log prints it

  function byHash(h) {
    for (var i = 0; i < commits.length; i++) if (commits[i].hash === h) return commits[i];
    return null;
  }
  // Refs for the commits that carry them.
  byHash(tips.main).refs.push({ kind: "head", label: "HEAD" }, { kind: "branch", label: "main" }, { kind: "remote", label: "origin/main" });
  byHash(tips["feature/search"]).refs.push({ kind: "branch", label: "feature/search" });
  byHash(releaseHash).refs.push({ kind: "tag", label: "v1.4.0" });

  function reachableFrom(tip) {
    var seen = {};
    var stack = [tip];
    while (stack.length) {
      var h = stack.pop();
      if (!h || seen[h]) continue;
      seen[h] = true;
      (byHash(h) || { parents: [] }).parents.forEach(function (p) { stack.push(p); });
    }
    return commits.filter(function (c) { return seen[c.hash]; });
  }

  // ---- Changed files per commit ------------------------------------------------------------
  var J = "src/main/java/com/acme/shop/";
  var POOL = [
    { status: "M", path: J + "checkout/CheckoutService.java" },
    { status: "A", path: J + "checkout/payment/PaymentGateway.java" },
    { status: "A", path: J + "checkout/payment/StripeAdapter.java" },
    { status: "M", path: J + "checkout/ShippingAddressValidator.java" },
    { status: "R", path: J + "cart/CartTotal.java", oldPath: J + "cart/CartSum.java" },
    { status: "M", path: J + "catalogue/ProductController.java" },
    { status: "M", path: "src/test/java/com/acme/shop/checkout/CheckoutServiceTest.java" },
    { status: "D", path: J + "legacy/OldPriceRules.java" },
    { status: "M", path: "src/main/resources/application.yml" },
    { status: "M", path: "README.md" },
  ];

  // The merge the README GIFs open — a fixed, deep Java change set so the tree view has folders to show.
  var CHECKOUT_MERGE_FILES = [
    { status: "M", path: J + "checkout/CheckoutService.java", insertions: 48, deletions: 6 },
    { status: "A", path: J + "checkout/payment/PaymentGateway.java", insertions: 31, deletions: 0 },
    { status: "A", path: J + "checkout/payment/StripeAdapter.java", insertions: 87, deletions: 0 },
    { status: "A", path: J + "checkout/ShippingAddressValidator.java", insertions: 42, deletions: 0 },
    { status: "A", path: J + "checkout/OrderSummary.java", insertions: 29, deletions: 0 },
    { status: "M", path: "src/main/resources/templates/checkout/summary.html", insertions: 64, deletions: 3 },
    { status: "A", path: "src/test/java/com/acme/shop/checkout/CheckoutServiceTest.java", insertions: 73, deletions: 0 },
    { status: "M", path: "src/main/resources/application.yml", insertions: 4, deletions: 1 },
  ];

  function filesFor(hash) {
    var c = byHash(hash);
    if (c && c.subject === "Merge branch 'feature/checkout'") return CHECKOUT_MERGE_FILES;
    var n = parseInt(hash.slice(0, 6), 16);
    var count = 4 + (n % 5);
    var out = [];
    for (var i = 0; i < count; i++) {
      var f = POOL[(n + i * 3) % POOL.length];
      if (out.some(function (o) { return o.path === f.path; })) continue;
      out.push({ status: f.status, path: f.path, oldPath: f.oldPath, insertions: f.status === "D" ? 0 : 3 + ((n >> i) % 60),
                 deletions: f.status === "A" ? 0 : (n >> (i + 2)) % 25 });
    }
    return out;
  }

  // ---- Host replies --------------------------------------------------------------------------
  function reply(msg) {
    setTimeout(function () { window.postMessage(msg, "*"); }, 40);
  }

  var BRANCH_NAMES = ["main", "feature/search", "feature/checkout", "fix/cart-total", "origin/main", "origin/feature/search"];

  function graphPayload(req) {
    // Same views as the extension: HEAD's own log, every branch (":all"), one branch, or several
    // names / `*` patterns (one path segment). Outside HEAD's log, commits HEAD cannot reach carry
    // offHead so the webview dims them.
    var revs = Array.isArray(req.revs) ? req.revs : req.rev ? [req.rev] : [];
    var onHead = {};
    reachableFrom(tips.main).forEach(function (c) { onHead[c.hash] = true; });
    var list, viewRev = "", viewRefs = [], revMissing = "";
    if (revs.indexOf(":all") >= 0) {
      list = commits;
      viewRev = ":all";
    } else if (revs.length) {
      var names = BRANCH_NAMES.filter(function (n) {
        return revs.some(function (r) {
          if (r.indexOf("*") < 0) return r === n;
          return new RegExp("^" + r.split("*").map(function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }).join("[^/]*") + "$").test(n);
        });
      });
      var seen = {};
      names.forEach(function (n) {
        reachableFrom(tips[n] || tips[n.replace(/^origin\//, "")]).forEach(function (c) { seen[c.hash] = true; });
      });
      list = commits.filter(function (c) { return seen[c.hash]; });
      if (!names.length) {
        revMissing = revs.join(", ");
        list = reachableFrom(tips.main);
      } else if (revs.length === 1 && revs[0].indexOf("*") < 0) {
        viewRev = revs[0];
      } else {
        viewRefs = names.map(function (n) { return (/^origin\//.test(n) ? "refs/remotes/" : "refs/heads/") + n; });
      }
    } else {
      list = reachableFrom(tips.main);
    }
    if (revs.length && !revMissing) {
      list = list.map(function (c) {
        if (onHead[c.hash]) return c;
        var copy = Object.assign({}, c);
        copy.offHead = true;
        return copy;
      });
    }
    var q = (req.query || "").toLowerCase();
    if (q) list = list.filter(function (c) { return c.subject.toLowerCase().indexOf(q) >= 0 || c.hash.indexOf(q) === 0; });
    return {
      commits: list.slice(0, req.limit || 200),
      repoRoot: "/Users/demo/acme-shop",
      repos: ["/Users/demo/acme-shop", "/Users/demo/acme-admin"],
      selectedRepo: "/Users/demo/acme-shop",
      branch: "main",
      viewRev: viewRev,
      viewRefs: viewRefs,
      revMissing: revMissing,
      requestedRevs: revs,
      // As in the extension: a deleted single branch is dropped; a list that matches nothing is kept.
      dropSelection: !!revMissing && revs.length === 1 && revs[0].indexOf("*") < 0,
      revMissingIsList: !!revMissing && (revs.length > 1 || revs[0].indexOf("*") >= 0),
      branchTree: { current: "main", locals: ["main", "feature/search", "feature/checkout", "fix/cart-total"],
                    remotes: [{ remote: "origin", branches: ["origin/main", "origin/feature/search"] }] },
      stashes: [{ ref: "stash@{0}", subject: "WIP on main: try lazy image loading", parentShort: tips.main.slice(0, 7) }],
      working: { staged: 1, modified: 3, untracked: 1, conflicted: 0 },
      sync: { upstream: "origin/main", ahead: 2, behind: 0 },
    };
  }

  var HANDLERS = {
    requestGraph: function (m) { reply({ type: "graphPayload", payload: graphPayload(m) }); },
    requestCommitFiles: function (m) { reply({ type: "commitFiles", hash: m.hash, files: filesFor(m.hash) }); },
    requestStashFiles: function (m) { reply({ type: "stashFiles", ref: m.hash, files: filesFor("abcdef12") }); },
    requestCompareFiles: function (m) { reply({ type: "compareFiles", a: m.a, b: m.b, files: filesFor(m.b) }); },
  };

  window.SENT = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        window.SENT.push(m);
        if (HANDLERS[m.type]) HANDLERS[m.type](m);
      },
      // Lets a test page start from saved webview state (e.g. a pre-1.5 `selectedRev`).
      getState: function () { return window.__GV_DEMO_STATE__ || null; },
      setState: function () {},
    };
  };
})();
