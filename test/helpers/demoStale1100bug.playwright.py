"""1.10.0 bug hunt: (1) a stale graph reply that arrives after a newer one is rendered over it;
(2) rendering 50,000 rows while the panel has no height (hidden tab, retainContextWhenHidden)
builds every row and draws the whole graph; (3) a 50,000-row page re-render cost.

Run: <playwright python> test/helpers/demoStale1100bug.playwright.py http://127.0.0.1:8765/out-demo/index.html
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("  -- " + str(info) if info != "" else ""))


GEN = """(n, tag) => {
  const h = i => ('0000000000000000000000000000000000000000' + i.toString(16)).slice(-40);
  const cs = [];
  for (let i = 0; i < n; i++) cs.push({ hash: h(i), shortHash: h(i).slice(-7), parents: i === n - 1 ? [] : [h(i + 1)], subject: tag + ' ' + i, author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', refs: [] });
  return cs;
}"""

SEND = """([gen, n, tag, extra]) => new Promise(res => {
  const cs = (0, eval)('(' + gen + ')')(n, tag);
  window.__LOCK = true;
  const pl = Object.assign({}, window.__T, { commits: cs, viewRev: '', requestedRevs: [] }, extra || {});
  const t0 = performance.now();
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
  window.__renderMs = performance.now() - t0;
  setTimeout(res, 200); })"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1400, "height": 820})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("""window.addEventListener('message', ev => {
      if (!ev.data || ev.data.type !== 'graphPayload') return;
      if (!window.__T) { window.__T = ev.data.payload; return; }
      if (window.__LOCK && !ev.data.ours) ev.stopImmediatePropagation();
    }, true);""")
    page.goto(URL)
    page.wait_for_function("!!window.__T")

    # (1) The user scrolled (page 2: a 5,000-row read-ahead on the host, slow), then typed a search
    # (first page, fast). Each request carries the webview's number and each reply echoes it; the
    # search reply lands first, the older page reply second and must be dropped.
    page.fill("#search-input", "match")
    page.wait_for_function("window.SENT.filter(m => m.type === 'requestGraph').length >= 2")
    page.wait_for_timeout(400)
    latest = page.evaluate("Math.max(...window.SENT.filter(m => m.type === 'requestGraph').map(m => m.requestId))")
    page.evaluate(SEND, [GEN, 3, "match", {"query": "match", "requestId": latest}])
    page.evaluate(SEND, [GEN, 400, "unfiltered", {"query": "", "requestId": latest - 1}])
    first = page.evaluate("() => (document.querySelector('.gv-commit-log-row') || {}).textContent || ''")
    check("stale page reply after a newer search reply is ignored", "match" in first, first[:60])
    page.evaluate(SEND, [GEN, 5, "newest", {"requestId": latest + 1}])
    first = page.evaluate("() => (document.querySelector('.gv-commit-log-row') || {}).textContent || ''")
    check("a reply to a request at least as new is drawn", "newest" in first, first[:60])

    # (2) Hidden panel: canvas has no height.
    page.evaluate("() => { document.getElementById('graph-svg').parentElement.style.display = 'none'; }")
    page.evaluate(SEND, [GEN, 50000, "hidden", {}])
    rows = page.evaluate("document.querySelectorAll('.gv-commit-log-row').length")
    nodes = page.evaluate("document.querySelectorAll('#graph-svg circle').length")
    check("hidden panel: rows built stay bounded (< 2000)", rows < 2000, rows)
    check("hidden panel: graph nodes drawn stay bounded (< 2000)", nodes < 2000, nodes)
    page.evaluate("() => { document.getElementById('graph-svg').parentElement.style.display = ''; }")
    page.wait_for_timeout(300)
    shown = page.evaluate("""() => { const svg = document.getElementById('graph-svg'); const box = svg.parentElement.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.gv-commit-log-row')].filter(r => { const b = r.getBoundingClientRect(); return b.top >= box.top && b.bottom <= box.bottom; }).length;
      const nodes = [...svg.querySelectorAll('circle')].filter(c => { const b = c.getBoundingClientRect(); return b.top >= box.top && b.bottom <= box.bottom; }).length;
      return [rows, nodes]; }""")
    check("shown again: the visible rows and their nodes are filled in", shown[0] > 15 and shown[1] >= shown[0], shown)

    # (3) Reaching 50,000 rows: past 1,000 the list grows in the host's read-ahead steps, so it is a
    # handful of re-renders, not 250 (each one re-sends and re-draws the whole list).
    steps = page.evaluate("""() => { let n = 200, k = 0; while (n < 50000) { n = GV.util.nextLimit(n, 200); k++; } return [k, n]; }""")
    check("200 → 50,000 rows in at most 10 loads", steps[0] <= 10 and steps[1] == 50000, steps)
    check("no page errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
