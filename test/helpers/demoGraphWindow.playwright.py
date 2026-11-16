"""1.10.0: the graph svg holds only rows near the viewport. Checks, with 6,000 generated commits:
nodes are drawn wherever you go (End / Home / a far jump), the selection ring sits on the selected
row, a commit whose parent is not loaded keeps its dashed run down to the end, and a long render
stays fast.

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoGraphWindow.playwright.py http://127.0.0.1:8765/out-demo/index.html
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(info)) if info and not ok else ""))


# A main line with a side branch merged every 50 commits; the oldest commit's parent is not loaded.
GEN = """n => {
  const h = i => ('0000000000000000000000000000000000000000' + i.toString(16)).slice(-40);
  const cs = [];
  for (let i = 0; i < n; i++) {
    const parents = i === n - 1 ? ['f'.repeat(40)] : [h(i + 1)];
    if (i % 50 === 0 && i + 3 < n) parents.push(h(1000000 + i));
    cs.push({ hash: h(i), shortHash: h(i).slice(-7), parents, subject: 'commit ' + i, author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', refs: [] });
    if (i % 50 === 0 && i + 3 < n) cs.push({ hash: h(1000000 + i), shortHash: 'side' + i, parents: [h(i + 3)], subject: 'side ' + i, author: 'B', authorEmail: 'b@x', date: '2026-01-01T00:00:00Z', refs: [] });
  }
  return cs;
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1400, "height": 820})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # Keep the template from the demo's first reply; once the generated list is shown, the demo's
    # answers to "load more" (its own small repository) are held back so they do not replace it.
    page.add_init_script("""window.addEventListener('message', ev => {
      if (!ev.data || ev.data.type !== 'graphPayload') return;
      if (!window.__T) { window.__T = ev.data.payload; return; }
      if (window.__LOCK && !ev.data.ours) ev.stopImmediatePropagation();
    }, true);""")
    page.goto(URL)
    page.wait_for_function("!!window.__T")
    took = page.evaluate("""gen => new Promise(res => {
      const cs = (0, eval)('(' + gen + ')')(6000);
      window.__N = cs.length;
      const pl = Object.assign({}, window.__T, { commits: cs, viewRev: ':all', requestedRevs: [':all'] });
      const t0 = performance.now();
      window.__LOCK = true;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
      requestAnimationFrame(() => setTimeout(() => res(performance.now() - t0), 0));
    })""", GEN)
    n = page.evaluate("window.__N")
    check(f"{n} rows render within 300 ms", took < 300, f"{took:.0f} ms")
    circles = page.locator("#graph-svg circle").count()
    check("only rows near the viewport are drawn", 0 < circles < 1200, circles)

    def nodes_in_view():
        return page.evaluate("""() => {
          const svg = document.getElementById('graph-svg'); const box = svg.parentElement.getBoundingClientRect();
          return [...svg.querySelectorAll('circle')].filter(c => { const r = c.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; }).length;
        }""")

    def ring_matches_selection():
        return page.evaluate("""() => {
          const ring = document.querySelector('#graph-svg .gv-node-selected');
          const row = document.querySelector('.gv-unified-row--selected');
          if (!ring || !row) return false;
          const a = ring.getBoundingClientRect(), r = row.getBoundingClientRect();
          return Math.abs((a.top + a.bottom) / 2 - (r.top + r.bottom) / 2) < 3;
        }""")

    page.click(".gv-commit-log-row >> nth=2")
    page.keyboard.press("End")
    page.wait_for_timeout(250)
    check("End: nodes drawn at the bottom of the list", nodes_in_view() > 5, nodes_in_view())
    check("End: selection ring on the last row", ring_matches_selection())
    tail = page.evaluate("""() => [...document.querySelectorAll('#graph-svg path[stroke-dasharray]')].length""")
    check("the unloaded parent of the last commit keeps its dashed run", tail >= 1, tail)

    page.keyboard.press("Home")
    page.wait_for_timeout(250)
    check("Home: nodes drawn at the top again", nodes_in_view() > 5, nodes_in_view())
    check("Home: selection ring on the first row", ring_matches_selection())

    page.evaluate("""() => { const s = document.getElementById('graph-svg').parentElement;
      s.scrollTop = s.scrollHeight * 0.55; }""")
    page.wait_for_timeout(250)
    check("a far jump: nodes drawn where you land", nodes_in_view() > 5, nodes_in_view())
    page.click(".gv-commit-log-row >> nth=5")
    page.wait_for_timeout(150)
    check("click after a jump: ring on the clicked row", ring_matches_selection())
    page.keyboard.press("PageDown")
    page.keyboard.press("PageDown")
    page.wait_for_timeout(250)
    check("Page Down twice: ring follows", ring_matches_selection())

    # 1.10.0 (#5): each row's text starts right after its own lanes, and never over a line.
    page2 = b.new_page(viewport={"width": 1400, "height": 820})
    page2.on("pageerror", lambda e: errors.append(str(e)))
    page2.goto(URL)
    page2.wait_for_selector(".gv-commit-log-row")
    page2.click("text=All branches")
    page2.wait_for_timeout(400)
    LEFTS = "() => [...document.querySelectorAll('.gv-commit-log-row')].map(r => parseFloat(r.style.paddingLeft))"
    lefts = page2.evaluate(LEFTS)
    check("lane alignment: rows with fewer lanes start further left", len(set(lefts)) >= 2, lefts)
    clear = page2.evaluate("""() => {
      const svg = document.getElementById('graph-svg');
      return [...document.querySelectorAll('.gv-commit-log-row')].every(row => {
        const r = row.getBoundingClientRect(), textLeft = r.left + parseFloat(row.style.paddingLeft);
        return [...svg.querySelectorAll('path, circle')].every(el => {
          const b = el.getBoundingClientRect();
          // Only marks fully inside this row's band; a mark there must end left of the text.
          if (b.top < r.top + 1 || b.bottom > r.bottom - 1) return true;
          return b.right <= textLeft + 0.5;
        });
      });
    }""")
    check("lane alignment: no line or node inside a row reaches under its text", clear)
    page2.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'column' }))")
    page2.wait_for_timeout(200)
    cols = page2.evaluate(LEFTS)
    check("column alignment (switched live): every row starts at the same place", len(set(cols)) == 1 and cols[0] >= max(lefts), cols)
    page2.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'lane' }))")
    page2.wait_for_timeout(200)
    check("back to lane alignment", page2.evaluate(LEFTS) == lefts)
    # 1.11.0: the right-hand details drop out for the whole list, not row by row.
    AUTHORS = "() => [...document.querySelectorAll('.gv-commit-log-row .gv-author')].map(a => getComputedStyle(a).display !== 'none')"
    for w in (1400, 1100, 900, 760):
        page2.set_viewport_size({"width": w, "height": 820})
        page2.wait_for_timeout(300)
        shown = page2.evaluate(AUTHORS)
        check(f"width {w}: author shown on every row or on none", len(set(shown)) == 1, shown)
    # The same thresholds as the container queries this replaced: the commit cell's inner width
    # (list − graph − its 20 px padding) at most 520 hides the author, at most 400 the time.
    page2.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'column' }))")
    wrong = []
    for vw in range(1300, 1760, 10):
        page2.set_viewport_size({"width": vw, "height": 820})
        page2.wait_for_timeout(120)
        r = page2.evaluate("""() => { const cell = document.querySelector('.gv-commit-log-row .gv-unified-commit');
          const cs = getComputedStyle(cell); const inner = cell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const vis = sel => getComputedStyle(document.querySelector('.gv-commit-log-row ' + sel)).display !== 'none';
          return { inner, author: vis('.gv-author'), time: vis('.gv-time') }; }""")
        if r["author"] != (r["inner"] > 520) or r["time"] != (r["inner"] > 400):
            wrong.append((vw, r))
    check("column alignment: author / time hide at the old inner-width thresholds (520 / 400)", not wrong, wrong[:3])
    page2.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'lane' }))")
    page2.close()

    # File history: one straight line with every node, not a lane per commit.
    page3 = b.new_page(viewport={"width": 1400, "height": 820})
    page3.on("pageerror", lambda e: errors.append(str(e)))
    page3.add_init_script("""window.addEventListener('message', ev => { if (!ev.data || ev.data.type !== 'graphPayload') return;
      if (!window.__T) { window.__T = ev.data.payload; return; } if (window.__LOCK && !ev.data.ours) ev.stopImmediatePropagation(); }, true);""")
    page3.goto(URL)
    page3.wait_for_function("!!window.__T")
    page3.evaluate("""() => new Promise(res => {
      const h = i => ('0000000000000000000000000000000000000000' + i.toString(16)).slice(-40);
      // Every listed commit's real parent changed other files: not in the list.
      const cs = []; for (let i = 0; i < 400; i++) cs.push({ hash: h(2 * i), shortHash: 's' + i, parents: [h(2 * i + 1)], subject: 'touch file ' + i, author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', refs: [] });
      window.__LOCK = true;
      const pl = Object.assign({}, window.__T, { commits: cs, pathFilter: 'src/file.ts', viewRev: '', requestedRevs: [] });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
      setTimeout(res, 300); })""")
    width = page3.evaluate("parseFloat(document.getElementById('graph-svg').getAttribute('width'))")
    check("file history: the graph is one lane wide", width <= 34, width)
    shown = page3.evaluate("""() => { const svg = document.getElementById('graph-svg'); const box = svg.parentElement.getBoundingClientRect();
      return [...svg.querySelectorAll('circle')].filter(c => { const r = c.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left; }).length; }""")
    rows = page3.evaluate("[...document.querySelectorAll('.gv-commit-log-row')].filter(r => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }).length")
    check("file history: a node on every visible row", shown >= rows * 2 - 2 and rows > 5, (shown, rows))
    page3.click(".gv-commit-log-row >> nth=3")
    page3.keyboard.press("Control+ArrowDown")
    page3.wait_for_timeout(150)
    sel = page3.evaluate("(document.querySelector('.gv-unified-row--selected') || {}).id || ''")
    check("file history: the parent key follows the line to the next row", sel == "gv-commit-row-4", sel)
    page3.close()

    # 1.11.0: a graph wider than the list's 40% — narrower lanes, then a cut with hollow edge nodes.
    page4 = b.new_page(viewport={"width": 1400, "height": 820})
    page4.on("pageerror", lambda e: errors.append(str(e)))
    page4.add_init_script("""window.addEventListener('message', ev => { if (!ev.data || ev.data.type !== 'graphPayload') return;
      if (!window.__T) { window.__T = ev.data.payload; return; } if (window.__LOCK && !ev.data.ours) ev.stopImmediatePropagation(); }, true);""")
    page4.goto(URL)
    page4.wait_for_function("!!window.__T")
    page4.evaluate("""() => new Promise(res => {
      // 120 branches side by side: commit k of branch b, interleaved, so all 120 lanes stay open.
      const h = (b, k) => ('0000000000000000000000000000000000000000' + (b * 1000 + k).toString(16)).slice(-40);
      const cs = []; for (let k = 0; k < 20; k++) for (let b = 0; b < 120; b++)
        cs.push({ hash: h(b, k), shortHash: 'b' + b + 'k' + k, parents: k < 19 ? [h(b, k + 1)] : [], subject: 'branch ' + b + ' commit ' + k, author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', refs: [] });
      window.__LOCK = true;
      const pl = Object.assign({}, window.__T, { commits: cs, viewRev: ':all', requestedRevs: [':all'] });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
      setTimeout(res, 400); })""")
    FIT = """() => { const svg = document.getElementById('graph-svg'); const box = svg.parentElement.getBoundingClientRect();
      const inView = el => { const r = el.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; };
      const rows = [...document.querySelectorAll('.gv-commit-log-row')].filter(inView);
      const nodes = [...svg.querySelectorAll('circle')].filter(c => inView(c) && (c.classList.contains('gv-node-cut') || c.getAttribute('stroke-width') === '2') && !c.classList.contains('gv-node-selected'));
      return { width: +svg.getAttribute('width'), list: svg.parentElement.clientWidth, rows: rows.length, nodes: nodes.length,
        cut: svg.querySelectorAll('.gv-node-cut').length, line: svg.querySelectorAll('.gv-graph-cut').length }; }"""
    f = page4.evaluate(FIT)
    check("wide graph: no wider than 40% of the list", f["width"] <= f["list"] * 0.4 + 1, f)
    check("wide graph: every visible row has its node", f["rows"] > 10 and f["nodes"] == f["rows"], f)
    check("wide graph: lanes past the cut drawn as hollow edge nodes, with the cut line", f["cut"] > 0 and f["line"] > 0, f)
    page4.set_viewport_size({"width": 2400, "height": 820})
    page4.wait_for_timeout(500)
    g = page4.evaluate(FIT)
    check("a wider list lays the graph out again, wider", g["width"] > f["width"] and g["width"] <= g["list"] * 0.4 + 1, (f["width"], g))
    check("still a node on every visible row after the resize", g["nodes"] == g["rows"], g)
    page4.close()

    check("no page errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
