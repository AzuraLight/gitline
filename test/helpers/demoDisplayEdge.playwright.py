"""Edge-case browser checks for the 1.7.0 display settings, against the demo page.

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8766 &
    <playwright python> test/helpers/demoDisplayEdge.playwright.py http://127.0.0.1:8766/out-demo/index.html
Prints one PASS/FAIL line per check; exit code 1 when any check fails.
"""
import re, sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8766/out-demo/index.html"
results = []
def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(info)) if info and not ok else ""))

def send(page, msg, wait=150):
    page.evaluate("m => window.postMessage(m, '*')", msg)
    page.wait_for_timeout(wait)

def visible_count(page, sel):
    return page.evaluate("""s => Array.from(document.querySelectorAll(s)).filter(e => e.offsetParent && getComputedStyle(e).display !== 'none').length""", sel)

def is_bottom(page):
    return page.eval_on_selector("#graph-workspace", "e => e.classList.contains('gv-details-bottom')")

def collapsed(page, pane):
    return page.eval_on_selector(f"[data-pane={pane}]", "e => e.classList.contains('gv-collapsed')")

def rect(page, sel):
    return page.evaluate("s => { const r = document.querySelector(s).getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right}; }", sel)

def overflow(page):
    return page.evaluate("""() => ({doc: document.documentElement.scrollWidth, win: innerWidth,
        rows: Array.from(document.querySelectorAll('.gv-commit-log-row')).filter(r => r.scrollWidth > r.clientWidth + 1).length})""")

def fresh(b, errors, vp, state=None):
    page = b.new_page(viewport=vp)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    if state is not None:
        page.add_init_script("window.__GV_DEMO_STATE__ = " + __import__("json").dumps(state))
    page.goto(URL); page.wait_for_selector(".gv-commit-log-row")
    return page

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    page = fresh(b, errors, {"width": 1400, "height": 700})

    # 1. Rapid detailsLocation toggling while the details pane is collapsed.
    page.click("[data-pane-toggle=preview]"); page.wait_for_timeout(100)
    check("preview collapsed by hand", collapsed(page, "preview"))
    for i in range(20):
        send(page, {"type": "displayPrefs", "display": {"detailsLocation": ["bottom", "right", "auto"][i % 3]}}, wait=0)
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "bottom"}}, wait=300)
    check("rapid toggle: ends bottom, still collapsed", is_bottom(page) and collapsed(page, "preview"), (is_bottom(page), collapsed(page, "preview")))
    h = rect(page, "[data-pane=preview]")["h"]
    check("rapid toggle: collapsed strip 28px tall in bottom", abs(h - 28) <= 1, h)
    check("rapid toggle: graph and preview not both collapsed", not (collapsed(page, "log") and collapsed(page, "preview")))
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "right"}}, wait=300)
    w = rect(page, "[data-pane=preview]")["w"]
    check("rapid toggle: back right, collapsed strip 28px wide", abs(w - 28) <= 1 and not is_bottom(page), w)
    page.click("[data-pane-toggle=preview]"); page.wait_for_timeout(100)

    # 2. Graph pane collapsed in bottom mode.
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "bottom"}}, wait=300)
    page.click("[data-pane-toggle=log]"); page.wait_for_timeout(200)
    lg, pv, ws = rect(page, "[data-pane=log]"), rect(page, "[data-pane=preview]"), rect(page, "#graph-workspace")
    check("bottom + graph collapsed: graph is a 28px strip", abs(lg["h"] - 28) <= 1, lg)
    check("bottom + graph collapsed: details fill the rest", pv["h"] > ws["h"] - 60 and pv["y"] >= lg["b"] - 1, (pv, ws))
    check("bottom + graph collapsed: splitter disabled", page.get_attribute("#split-preview", "aria-disabled") == "true", page.get_attribute("#split-preview", "aria-disabled"))
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "right"}}, wait=300)
    lg = rect(page, "[data-pane=log]")
    check("graph collapsed survives switching to right (28px wide strip)", abs(lg["w"] - 28) <= 1, lg)
    page.click("[data-pane-toggle=log]"); page.wait_for_timeout(200)

    # 3. Splitter keyboard in bottom mode.
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "bottom"}}, wait=300)
    page.focus("#split-preview")
    h0 = rect(page, "[data-pane=preview]")["h"]
    page.keyboard.press("ArrowLeft"); page.keyboard.press("ArrowRight"); page.wait_for_timeout(100)
    check("bottom: Left/Right do nothing", abs(rect(page, "[data-pane=preview]")["h"] - h0) < 1)
    page.keyboard.press("Shift+ArrowUp"); page.wait_for_timeout(100)
    h1 = rect(page, "[data-pane=preview]")["h"]
    check("bottom: Shift+ArrowUp grows by 64", 56 <= h1 - h0 <= 72, (h0, h1))
    for _ in range(80): page.keyboard.press("Shift+ArrowUp")
    pv, ws = rect(page, "[data-pane=preview]"), rect(page, "#graph-workspace")
    check("bottom: growing stops leaving >=120px graph", ws["h"] - pv["h"] >= 115, (pv["h"], ws["h"]))
    check("bottom: aria-valuenow <= aria-valuemax", float(page.get_attribute("#split-preview", "aria-valuenow") or 0) <= float(page.get_attribute("#split-preview", "aria-valuemax") or 0))
    for _ in range(80): page.keyboard.press("Shift+ArrowDown")
    h2 = rect(page, "[data-pane=preview]")["h"]
    check("bottom: shrinking stops at 120 (no snap-collapse)", 118 <= h2 <= 122 and not collapsed(page, "preview"), h2)
    hb = rect(page, "[data-pane=preview]")["h"]
    page.keyboard.press("Home"); page.keyboard.press("End"); page.wait_for_timeout(100)
    check("bottom: Home/End are ignored (not supported) without errors", abs(rect(page, "[data-pane=preview]")["h"] - hb) < 1)
    page.keyboard.press("Enter"); page.wait_for_timeout(150)
    check("bottom: Enter collapses details", collapsed(page, "preview"))
    page.focus("#split-preview"); page.keyboard.press("Enter"); page.wait_for_timeout(150)
    check("bottom: Enter again restores", not collapsed(page, "preview"))
    page.dblclick("#split-preview"); page.wait_for_timeout(150)
    saved = page.evaluate("window.__GV_DEMO_SAVED__ && window.__GV_DEMO_SAVED__.layout") or {}
    check("bottom: double-click resets previewH only", saved.get("previewH", -1) == 0, saved)
    pv, ws = rect(page, "[data-pane=preview]"), rect(page, "#graph-workspace")
    check("bottom: reset is ~40% height", abs(pv["h"] / ws["h"] - 0.4) < 0.1, (pv["h"], ws["h"]))
    page.close()

    # 4. Reload with a saved previewH while in right mode: previewW must not change.
    state = {"layout": {"sidebarW": 220, "previewW": 420, "previewH": 260, "collapsed": {}}}
    page = fresh(b, errors, {"width": 1400, "height": 700}, state)
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "right"}}, wait=300)
    w = rect(page, "[data-pane=preview]")["w"]
    check("reload right: preview uses saved previewW 420", abs(w - 420) <= 2, w)
    page.focus("#split-preview"); page.keyboard.press("ArrowLeft"); page.wait_for_timeout(100)
    saved = page.evaluate("window.__GV_DEMO_SAVED__ && window.__GV_DEMO_SAVED__.layout") or {}
    check("reload right: keyboard step changes previewW, keeps previewH 260", saved.get("previewH") == 260 and saved.get("previewW") == 436, saved)
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "bottom"}}, wait=300)
    h = rect(page, "[data-pane=preview]")["h"]
    check("then bottom: preview uses saved previewH 260", abs(h - 260) <= 2, h)
    page.focus("#split-preview"); page.keyboard.press("ArrowUp"); page.wait_for_timeout(100)
    saved = page.evaluate("window.__GV_DEMO_SAVED__ && window.__GV_DEMO_SAVED__.layout") or {}
    check("bottom step changes previewH only", saved.get("previewW") == 436 and saved.get("previewH") == 276, saved)
    page.close()

    # 5. Viewport resized repeatedly across the auto threshold.
    page = fresh(b, errors, {"width": 700, "height": 760})
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "auto"}})
    flips = []
    for i in range(8):
        page.set_viewport_size({"width": 600 if i % 2 == 0 else 700, "height": 760}); page.wait_for_timeout(150)
        flips.append((is_bottom(page), collapsed(page, "preview"), collapsed(page, "log")))
    exp = [(True, False, False), (False, False, False)] * 4
    check("auto flips bottom<->right each resize, nothing folded", flips == exp, flips)
    # Fold by height, open by hand, then grow and shrink across AUTO_H.
    page.set_viewport_size({"width": 600, "height": 380}); page.wait_for_timeout(200)
    st = (is_bottom(page), collapsed(page, "preview"))
    check("600x380: bottom, details visible", st == (True, False), st)
    errs_before = len(errors)
    for hgt in [370, 400, 330, 420, 320, 340, 800, 400]:
        page.set_viewport_size({"width": 600, "height": hgt}); page.wait_for_timeout(120)
    st = (is_bottom(page), collapsed(page, "preview"), collapsed(page, "log"))
    check("height jitter around the threshold: ends bottom, both visible", st == (True, False, False), st)
    page.set_viewport_size({"width": 639, "height": 500}); page.wait_for_timeout(150)
    a = is_bottom(page)
    page.set_viewport_size({"width": 640, "height": 500}); page.wait_for_timeout(150)
    b2 = is_bottom(page)
    # resolveLocation is called with the root's size, not the viewport; report what is measured.
    root = page.evaluate("(() => { const r = document.querySelector('#graph-workspace').closest('.gv-shell') || document.body; return [r.clientWidth, r.clientHeight]; })()")
    check("639 vs 640 viewport (h500): flips location", a and not b2, (a, b2, root))
    check("no errors during resize jitter", len(errors) == errs_before, errors[errs_before:])
    page.close()

    # 6. All three columns hidden at 320px wide.
    page = fresh(b, errors, {"width": 320, "height": 640})
    send(page, {"type": "displayPrefs", "display": {"columns": {"author": False, "date": False, "sha": False}}}, wait=300)
    check("all hidden: no author/date/hash visible", visible_count(page, ".gv-commit-log-row .gv-author") + visible_count(page, ".gv-commit-log-row .gv-time") + visible_count(page, ".gv-commit-log-row .gv-hash") == 0)
    o = overflow(page)
    check("all hidden @320: no horizontal page scroll", o["doc"] <= o["win"], o)
    check("all hidden @320: rows do not overflow", o["rows"] == 0, o)
    msgw = page.evaluate("(() => { const m = document.querySelector('.gv-commit-log-row .gv-msg, .gv-commit-log-row .gv-subject'); return m ? m.getBoundingClientRect().width : -1; })()")
    check("all hidden @320: message has room", msgw != 0, msgw)
    rh = page.evaluate("Array.from(new Set(Array.from(document.querySelectorAll('.gv-commit-log-row')).map(r => Math.round(r.getBoundingClientRect().height))))")
    check("all hidden: row height uniform", len(rh) == 1, rh)
    page.click(".gv-unified-head", button="right")
    st = [i.get_attribute("aria-checked") for i in page.query_selector_all("#ctx-menu [role=menuitemcheckbox]")]
    check("all hidden: menu shows all unchecked", st == ["false"] * 3, st)
    mr = rect(page, "#ctx-menu")
    check("menu stays in a 320px viewport", mr["x"] >= 0 and mr["r"] <= 320, mr)
    page.keyboard.press("Escape")
    page.close()

    # 7. Absolute dates while the date column is hidden, then shown.
    page = fresh(b, errors, {"width": 1400, "height": 700})
    send(page, {"type": "displayPrefs", "display": {"columns": {"date": False}}})
    send(page, {"type": "displayPrefs", "display": {"columns": {"date": False}, "dateFormat": "absolute"}})
    send(page, {"type": "displayPrefs", "display": {"dateFormat": "absolute"}}, wait=250)
    texts = page.evaluate("Array.from(document.querySelectorAll('.gv-commit-log-row .gv-time')).map(e => e.textContent)")
    check("date shown again: all rows absolute", texts and all(re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d", t) for t in texts), texts[:5])
    page.evaluate("document.querySelector('.gv-graph-canvas').scrollTop = 99999"); page.wait_for_timeout(300)
    texts = page.evaluate("Array.from(document.querySelectorAll('.gv-commit-log-row .gv-time')).map(e => e.textContent)")
    check("virtual rows after scroll also absolute", texts and all(re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d", t) for t in texts), texts[:5])
    page.evaluate("document.querySelector('.gv-graph-canvas').scrollTop = 0"); page.wait_for_timeout(200)

    # 8. Tint + selection + marked rows.
    send(page, {"type": "applyView", "revs": [":all"]}, wait=400)
    send(page, {"type": "displayPrefs", "display": {"highlightCurrentBranch": True}}, wait=200)
    bgs = lambda sel: page.evaluate("s => Array.from(document.querySelectorAll(s)).map(e => getComputedStyle(e).backgroundColor)", sel)
    plain = page.evaluate("(() => { const r = Array.from(document.querySelectorAll('.gv-unified-row--onhead')).find(e => !e.classList.contains('gv-unified-row--selected')); return getComputedStyle(r).backgroundColor; })()")
    onrows = page.locator(".gv-unified-row--onhead")
    onrows.nth(1).click(); page.mouse.move(5, 690); page.wait_for_timeout(200)
    selbg = "(() => { const r = document.querySelector('.gv-unified-row--selected'); return r ? [getComputedStyle(r).backgroundColor, r.classList.contains('gv-unified-row--onhead')] : null; })()"
    sel_bg = page.evaluate(selbg)
    check("selected on-head row: selection colour wins over tint", sel_bg and sel_bg[1] and sel_bg[0] != plain, (sel_bg, plain))
    send(page, {"type": "displayPrefs", "display": {"highlightCurrentBranch": False}}, wait=200)
    sel2 = page.evaluate(selbg)
    check("selection colour unchanged by tint off", sel2 and sel2[0] == sel_bg[0], (sel2, sel_bg))
    mhash = page.evaluate("document.querySelectorAll('.gv-unified-row--onhead')[2].dataset.hash")
    page.close()
    # Marked (compare) row: restored from saved state, then tinted.
    page = fresh(b, errors, {"width": 1400, "height": 700}, {"markedHash": mhash})
    send(page, {"type": "applyView", "revs": [":all"]}, wait=400)
    send(page, {"type": "displayPrefs", "display": {"highlightCurrentBranch": True}}, wait=200)
    page.mouse.move(5, 690)
    m = page.evaluate("h => { const r = document.querySelector('[data-hash=\"' + h + '\"]'); return r && [r.className, getComputedStyle(r).boxShadow, getComputedStyle(r).backgroundColor]; }", mhash)
    check("marked + tinted row keeps its orange mark and the tint", m and "marked" in m[0] and "inset" in m[1] and m[2] == plain, (m, plain))

    # 9. Column menu keyboard.
    page.click(".gv-unified-head", button="right"); page.wait_for_timeout(100)
    check("menu open", page.is_visible("#ctx-menu"))
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    check("Escape closes the column menu", not page.is_visible("#ctx-menu"))
    page.click(".gv-unified-head", button="right"); page.wait_for_timeout(100)
    in_menu = page.evaluate("document.getElementById('ctx-menu').contains(document.activeElement)")
    check("column menu takes focus when opened", in_menu, page.evaluate("document.activeElement && document.activeElement.outerHTML.slice(0, 80)"))
    page.keyboard.press("Escape")
    focusable = page.evaluate("(() => { const h = document.querySelector('.gv-unified-head'); return h.tabIndex >= 0 || h.querySelector('[tabindex],button') !== null; })()")
    check("column header is keyboard-reachable (Shift+F10 / ContextMenu key)", focusable)
    page.focus("#ctx-menu") if False else None
    page.click(".gv-unified-head", button="right"); page.wait_for_timeout(100)
    page.focus("#ctx-menu [role=menuitemcheckbox]:nth-child(1)"); page.keyboard.press("Enter"); page.wait_for_timeout(250)
    check("Enter on a focused item toggles author", visible_count(page, ".gv-commit-log-row .gv-author") == 0 and not page.is_visible("#ctx-menu"))
    page.close()

    check("no console errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
