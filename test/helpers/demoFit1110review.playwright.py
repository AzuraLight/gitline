"""1.11.0 review probes: graph fit on resize (scroll kept, selection kept, no render loop, hidden panel),
text vs lanes overlap, cut nodes.
Run: <playwright python> test/helpers/demoFit1110review.playwright.py <payload.json> [url]
"""
import json
import sys
from playwright.sync_api import sync_playwright

PAYLOAD = sys.argv[1]
URL = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8765/out-demo/index.html"
commits = json.load(open(PAYLOAD))
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + "  -- " + str(info))


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
    took = page.evaluate("""cs => new Promise(res => {
      const pl = Object.assign({}, window.__T, { commits: cs, viewRev: ':all', requestedRevs: [':all'] });
      window.__LOCK = true;
      const t0 = performance.now();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
      requestAnimationFrame(() => setTimeout(() => res(performance.now() - t0), 0));
    })""", commits)
    print("render ms", round(took))
    canvas = "document.getElementById('graph-root').parentElement"
    # count re-renders: svg width changes / innerHTML resets
    page.evaluate(f"""() => {{ window.__R = 0; new MutationObserver(m => {{ for (const x of m) for (const n of x.removedNodes) if (n.classList && n.classList.contains('gv-commit-log-row')) {{ window.__R++; return; }} }}).observe(document.getElementById('graph-root'), {{ childList: true, subtree: true }}); }}""")
    info0 = page.evaluate(f"() => ({{ w: {canvas}.clientWidth, svgW: document.getElementById('graph-svg').getAttribute('width'), cut: document.querySelectorAll('.gv-node-cut').length, line: document.querySelectorAll('.gv-graph-cut').length, cls: document.getElementById('graph-root').className }})")
    print("initial", info0)

    # scroll to the middle and select a visible row
    page.evaluate(f"() => {{ {canvas}.scrollTop = 30000; }}")
    page.wait_for_timeout(200)
    page.click(".gv-commit-log-row >> nth=5")
    page.wait_for_timeout(200)
    sel0 = page.evaluate("() => { const r = document.querySelector('.gv-unified-row--selected'); return r && r.textContent.slice(0, 60); }")
    st0 = page.evaluate(f"() => {canvas}.scrollTop")

    for vw in [1100, 800, 600, 1400]:
        page.set_viewport_size({"width": vw, "height": 820})
        page.wait_for_timeout(400)
        st = page.evaluate(f"() => {canvas}.scrollTop")
        sel = page.evaluate("() => { const r = document.querySelector('.gv-unified-row--selected'); return r && r.textContent.slice(0, 60); }")
        ring = page.evaluate("""() => { const ring = document.querySelector('#graph-svg .gv-node-selected'); const row = document.querySelector('.gv-unified-row--selected');
           if (!ring || !row) return null; const a = ring.getBoundingClientRect(), r = row.getBoundingClientRect(); return Math.round((a.top + a.bottom) / 2 - (r.top + r.bottom) / 2); }""")
        info = page.evaluate(f"() => ({{ w: {canvas}.clientWidth, svgW: document.getElementById('graph-svg').getAttribute('width'), cut: document.querySelectorAll('.gv-node-cut').length, cls: document.getElementById('graph-root').className, R: window.__R }})")
        check(f"viewport {vw}: scrollTop kept", abs(st - st0) < 2, f"{st0} -> {st}; {info}")
        check(f"viewport {vw}: selection kept", sel == sel0, sel)
        check(f"viewport {vw}: ring on selected row", ring is not None and abs(ring) < 3, ring)
        # text overlap: each row's text left must be >= rightmost drawn node of that row
        ov = page.evaluate("""() => {
          const svg = document.getElementById('graph-svg'); const bad = [];
          const nodes = [...svg.querySelectorAll('circle')].map(c => c.getBoundingClientRect());
          for (const row of document.querySelectorAll('.gv-commit-log-row')) {
            const rr = row.getBoundingClientRect();
            const txt = row.querySelector('.gv-unified-commit') || row;
            const tl = txt.getBoundingClientRect().left;
            for (const n of nodes) { const cy = (n.top + n.bottom) / 2; if (cy > rr.top && cy < rr.bottom && n.right > tl + 0.5) { bad.push([Math.round(n.right), Math.round(tl)]); break; } }
          }
          return bad.slice(0, 3).concat([bad.length]); }""")
        check(f"viewport {vw}: no node under text", ov[-1] == 0, ov)

    # render loop guard: count renders over 1 s idle
    r1 = page.evaluate("window.__R")
    page.wait_for_timeout(1000)
    check("no idle re-render loop", page.evaluate("window.__R") == r1, page.evaluate("window.__R") - r1)

    # hidden panel then shown
    page.evaluate(f"() => {{ {canvas}.style.display = 'none'; }}")
    page.wait_for_timeout(300)
    page.evaluate(f"() => {{ {canvas}.style.display = ''; }}")
    page.wait_for_timeout(400)
    st = page.evaluate(f"() => {canvas}.scrollTop")
    sel = page.evaluate("() => { const r = document.querySelector('.gv-unified-row--selected'); return r && r.textContent.slice(0, 60); }")
    check("hidden->shown: scrollTop kept", abs(st - st0) < 2, f"{st0} -> {st}")
    check("hidden->shown: selection kept", sel == sel0, sel)
    check("no page errors", not errors, errors[:3])
    b.close()

print(f"{sum(1 for _, ok in results if ok)}/{len(results)} passed")
