"""Second 1.11.0 review probes.
Run: <playwright python> test/helpers/demoFit1110second.playwright.py <payload.json> [url]
1. "column" alignment: fitColumns thresholds vs the old @container gv-commit rule (content box <= N).
2. 50,000-row refit on resize: scrollTop / selection kept, time per refit.
3. graph -> working-changes-only payload: stale .gv-fit-* classes / --gv-graph-w.
4. pending refit frame then an error card: no rows come back.
"""
import sys
from playwright.sync_api import sync_playwright

PAYLOAD = sys.argv[1]
URL = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8765/out-demo/index.html"
RAW = open(PAYLOAD).read()
CANVAS = "document.getElementById('graph-root').parentElement"


def send(page, extra_js):
    page.evaluate("""extra => new Promise(res => {
      const pl = Object.assign({}, window.__T, eval('(' + extra + ')'));
      window.__LOCK = true;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
      requestAnimationFrame(() => setTimeout(res, 0));
    })""", extra_js)


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
    page.evaluate("raw => { window.__C = JSON.parse(raw); }", RAW)
    send(page, "{ commits: window.__C, viewRev: ':all', requestedRevs: [':all'] }")

    # 1. column alignment thresholds
    page.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'column' }))")
    page.wait_for_timeout(200)
    mism = []
    for vw in range(700, 1400, 4):
        page.set_viewport_size({"width": vw, "height": 820})
        page.wait_for_timeout(60)
        r = page.evaluate("""() => { const cell = document.querySelector('.gv-commit-log-row .gv-unified-commit');
          const cs = getComputedStyle(cell); const content = cell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const a = cell.querySelector('.gv-author'); return { content, author: !!a && getComputedStyle(a).display !== 'none',
          cls: document.getElementById('graph-root').className } }""")
        old_author = r["content"] > 520
        if old_author != r["author"]:
            mism.append((vw, round(r["content"]), r["author"]))
    print("column mode: viewports where author visibility differs from the old container query:", len(mism), mism[:3], mism[-1:] if mism else "")
    page.evaluate("() => GV.display.set(Object.assign({}, GV.display.get(), { messageAlignment: 'lane' }))")

    # 2. 50k refit: scroll + selection + time
    page.set_viewport_size({"width": 1400, "height": 820})
    page.wait_for_timeout(300)
    page.evaluate(f"() => {{ {CANVAS}.scrollTop = 600000; }}")
    page.wait_for_timeout(300)
    page.click(".gv-commit-log-row >> nth=6")
    st0 = page.evaluate(f"() => {CANVAS}.scrollTop")
    sel0 = page.evaluate("() => document.querySelector('.gv-unified-row--selected').dataset.hash")
    page.evaluate("""() => { window.__times = []; const orig = GV.laneLayout.fitLanes; }""")
    for vw in [1300, 1000, 760, 500, 1400]:
        t = page.evaluate("""vw => new Promise(res => { const t0 = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => res(performance.now() - t0), 0))); })""", vw)
        page.set_viewport_size({"width": vw, "height": 820})
        page.wait_for_timeout(250)
        st = page.evaluate(f"() => {CANVAS}.scrollTop")
        sel = page.evaluate("() => { const r = document.querySelector('.gv-unified-row--selected'); return r && r.dataset.hash; }")
        ring = page.evaluate("() => !!document.querySelector('#graph-svg .gv-node-selected')")
        print(f"50k vw={vw}: scrollTop {st0}->{st} sel kept={sel == sel0} ring={ring} svgW={page.evaluate('() => document.getElementById(\"graph-svg\").getAttribute(\"width\")')}")
    # time one forced refit
    ms = page.evaluate("""() => new Promise(res => { const t0 = performance.now(); const c = document.getElementById('graph-root').parentElement;
       c.style.width = '700px'; requestAnimationFrame(() => requestAnimationFrame(() => { const d = performance.now() - t0; c.style.width = ''; res(d); })); })""")
    print("50k one refit (two frames incl. render) ms", round(ms))

    # 4. pending refit then error card
    page.set_viewport_size({"width": 1400, "height": 820})
    page.wait_for_timeout(300)
    page.evaluate(f"""() => {{ {CANVAS}.style.width = '500px';
      void {CANVAS}.clientWidth; }}""")
    page.evaluate("""() => new Promise(res => { setTimeout(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphError', code: 'error', message: 'boom', requestId: 999999 } }));
      res(); }, 0); })""")
    page.wait_for_timeout(300)
    rows = page.evaluate("() => document.querySelectorAll('.gv-commit-log-row').length")
    print("after error card during pending refit: rows =", rows)
    page.evaluate(f"() => {{ {CANVAS}.style.width = ''; }}")

    # 3. graph then working-only payload: stale classes
    send(page, "{ commits: window.__C.slice(0, 200), viewRev: ':all', requestedRevs: [':all'] }")
    page.set_viewport_size({"width": 700, "height": 820})
    page.wait_for_timeout(300)
    before = page.evaluate(f"() => [document.getElementById('graph-root').className, {CANVAS}.style.getPropertyValue('--gv-graph-w')]")
    send(page, "{ commits: [], working: { staged: 1, modified: 0, untracked: 0, conflicted: 0 }, stashes: [] }")
    page.wait_for_timeout(200)
    after = page.evaluate(f"() => [document.getElementById('graph-root').className, {CANVAS}.style.getPropertyValue('--gv-graph-w'), document.querySelectorAll('.gv-virtual-row').length]")
    print("graph state:", before, " working-only state:", after)
    print("page errors:", errors[:3])
    b.close()
