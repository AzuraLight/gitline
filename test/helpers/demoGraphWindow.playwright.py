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

    check("no page errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
