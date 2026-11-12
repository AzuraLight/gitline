"""1.10.0 edge: switching gitline.graph.messageAlignment live while scrolled down with a commit
selected must keep the scroll position, the selection ring and the graph drawn in view.
Also: scrolling while the canvas grows (resize) keeps nodes drawn.

Run: <playwright python> test/helpers/demoAlign1100edge.playwright.py http://127.0.0.1:8765/out-demo/index.html
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("  -- " + str(info) if info != "" else ""))


GEN = """n => {
  const h = i => ('0000000000000000000000000000000000000000' + i.toString(16)).slice(-40);
  const cs = [];
  for (let i = 0; i < n; i++) cs.push({ hash: h(i), shortHash: h(i).slice(-7), parents: i === n - 1 ? [] : [h(i + 1)], subject: 'commit ' + i, author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', refs: [] });
  return cs;
}"""

RING = """() => { const ring = document.querySelector('#graph-svg .gv-node-selected');
  const row = document.querySelector('.gv-unified-row--selected');
  if (!ring || !row) return 'ring=' + !!ring + ' row=' + !!row;
  const a = ring.getBoundingClientRect(), r = row.getBoundingClientRect();
  return Math.abs((a.top + a.bottom) / 2 - (r.top + r.bottom) / 2) < 3 ? 'ok' : 'off'; }"""
INVIEW = """() => { const svg = document.getElementById('graph-svg'); const box = svg.parentElement.getBoundingClientRect();
  return [...svg.querySelectorAll('circle:not(.gv-node-selected)')].filter(c => { const r = c.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; }).length; }"""
SCROLL = "() => document.getElementById('graph-svg').parentElement.scrollTop"

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
    page.evaluate("""gen => new Promise(res => {
      const cs = (0, eval)('(' + gen + ')')(3000);
      window.__LOCK = true;
      const pl = Object.assign({}, window.__T, { commits: cs, viewRev: ':all', requestedRevs: [':all'] });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
      setTimeout(res, 300); })""", GEN)
    page.evaluate("() => { const s = document.getElementById('graph-svg').parentElement; s.scrollTop = s.scrollHeight * 0.5; }")
    page.wait_for_timeout(250)
    page.click(".gv-commit-log-row >> nth=10")
    page.wait_for_timeout(150)
    before = page.evaluate(SCROLL)
    check("precondition: ring on selected row", page.evaluate(RING) == "ok", page.evaluate(RING))
    page.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'column' }))")
    page.wait_for_timeout(300)
    after = page.evaluate(SCROLL)
    check("alignment switch keeps the scroll position", abs(after - before) < 2, (before, after))
    check("alignment switch keeps the selection ring", page.evaluate(RING) == "ok", page.evaluate(RING))
    check("alignment switch: nodes drawn in view", page.evaluate(INVIEW) > 5, page.evaluate(INVIEW))

    # Resize taller with no scroll event: are newly exposed rows drawn?
    page.evaluate("() => { const s = document.getElementById('graph-svg').parentElement; s.scrollTop = 0; }")
    page.wait_for_timeout(250)
    page.set_viewport_size({"width": 1400, "height": 3000})
    page.wait_for_timeout(400)
    rows_vis = page.evaluate("[...document.querySelectorAll('.gv-commit-log-row')].filter(r => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }).length")
    check("after a taller resize, every visible row has a node", page.evaluate(INVIEW) >= rows_vis - 1, (page.evaluate(INVIEW), rows_vis))
    check("no page errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
