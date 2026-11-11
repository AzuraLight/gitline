"""Browser checks for the 1.7.0 display settings (columns, date format, details location, tint),
against the demo page (tools/demo/mock-host.js).

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoDisplay.playwright.py http://127.0.0.1:8765/out-demo/index.html
Prints one PASS/FAIL line per check; exit code 1 when any check fails.
"""
import re, sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []
def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(info)) if info and not ok else ""))

def send(page, msg):
    page.evaluate("m => window.postMessage(m, '*')", msg)
    page.wait_for_timeout(150)

def visible_count(page, sel):
    return page.evaluate("""s => Array.from(document.querySelectorAll(s)).filter(e => e.offsetParent && getComputedStyle(e).display !== 'none').length""", sel)

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    page = b.new_page(viewport={"width": 1700, "height": 600})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(URL); page.wait_for_selector(".gv-commit-log-row")

    check("default: author, date, hash visible", visible_count(page, ".gv-commit-log-row .gv-author") > 0 and visible_count(page, ".gv-commit-log-row .gv-time") > 0 and visible_count(page, ".gv-commit-log-row .gv-hash") > 0)
    check("header has a hint tooltip", page.get_attribute(".gv-unified-head", "title"))

    page.click(".gv-unified-head", button="right")
    items = page.query_selector_all("#ctx-menu [role=menuitemcheckbox]")
    check("column menu: 3 checkbox items, all checked", len(items) == 3 and all(i.get_attribute("aria-checked") == "true" for i in items), len(items))
    page.click("#ctx-menu [role=menuitemcheckbox]:nth-child(2)")
    page.wait_for_timeout(200)
    check("date hidden after unchecking", visible_count(page, ".gv-commit-log-row .gv-time") == 0)
    sent = page.evaluate("window.SENT.filter(m => m.type === 'setColumns')")
    check("setColumns posted with date false", sent and sent[-1]["columns"] == {"author": True, "date": False, "sha": True}, sent)
    page.click(".gv-unified-head", button="right")
    states = [i.get_attribute("aria-checked") for i in page.query_selector_all("#ctx-menu [role=menuitemcheckbox]")]
    check("menu reflects the change", states == ["true", "false", "true"], states)
    page.keyboard.press("Escape")

    # Rows built later by virtual scrolling also follow the setting.
    page.evaluate("document.querySelector('.gv-graph-canvas').scrollTop = 99999")
    page.wait_for_timeout(300)
    check("virtual rows after scroll keep date hidden", visible_count(page, ".gv-commit-log-row .gv-time") == 0)
    page.evaluate("document.querySelector('.gv-graph-canvas').scrollTop = 0")

    send(page, {"type": "displayPrefs", "display": {"columns": {"author": False, "sha": False}, "dateFormat": "absolute"}})
    check("settings echo: author+sha hidden, date back", visible_count(page, ".gv-commit-log-row .gv-author") == 0 and visible_count(page, ".gv-commit-log-row .gv-hash") == 0 and visible_count(page, ".gv-commit-log-row .gv-time") > 0)
    t = page.text_content(".gv-commit-log-row .gv-time")
    title = page.get_attribute(".gv-commit-log-row .gv-time", "title")
    check("absolute date text", re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d", t or ""), t)
    check("tooltip has relative form", title and "ago" in title, title)
    send(page, {"type": "displayPrefs", "display": {}})
    t = page.text_content(".gv-commit-log-row .gv-time")
    check("back to relative", t and "ago" in t, t)

    # Tint: HEAD view → no onhead rows; All branches → onhead rows, tinted only with the setting.
    check("HEAD view: no on-head marks", page.locator(".gv-unified-row--onhead").count() == 0)
    send(page, {"type": "applyView", "revs": [":all"]}); page.wait_for_timeout(300)
    on = page.locator(".gv-unified-row--onhead").count(); off = page.locator(".gv-unified-row--offhead").count()
    check("All view: on-head and off-head rows", on > 0 and off > 0, (on, off))
    bg = lambda: page.evaluate("""() => { const r = Array.from(document.querySelectorAll('.gv-unified-row--onhead')).find(e => !e.classList.contains('gv-unified-row--selected')); return getComputedStyle(r).backgroundColor; }""")
    before = bg()
    send(page, {"type": "displayPrefs", "display": {"highlightCurrentBranch": True}})
    after = bg()
    offbg = page.evaluate("getComputedStyle(document.querySelector('.gv-unified-row--offhead')).backgroundColor")
    check("tint applied to on-head rows only", before != after and offbg != after, (before, after, offbg))
    send(page, {"type": "displayPrefs", "display": {}})
    check("tint removed when off", bg() == before)

    # Details location.
    ws = "#graph-workspace"
    check("wide panel auto → right", not page.eval_on_selector(ws, "e => e.classList.contains('gv-details-bottom')"))
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "bottom"}})
    geo = page.evaluate("""() => { const l = document.querySelector('[data-pane=log]').getBoundingClientRect(), p = document.querySelector('[data-pane=preview]').getBoundingClientRect(); return {lb: l.bottom, pt: p.top, pw: p.width, lw: l.width, ph: p.height}; }""")
    check("bottom: preview below graph, full width", geo["pt"] >= geo["lb"] - 1 and abs(geo["pw"] - geo["lw"]) < 2 and geo["ph"] >= 119, geo)
    check("splitter horizontal", page.get_attribute("#split-preview", "aria-orientation") == "horizontal")
    box = page.query_selector("#split-preview").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 2); page.mouse.down()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] - 80, steps=5); page.mouse.up()
    ph2 = page.evaluate("document.querySelector('[data-pane=preview]').getBoundingClientRect().height")
    check("drag up grows details", ph2 > geo["ph"] + 60, (geo["ph"], ph2))
    saved = page.evaluate("window.__GV_DEMO_SAVED__ && window.__GV_DEMO_SAVED__.layout")
    check("height saved as previewH", saved and saved.get("previewH", 0) > 0 and saved.get("previewW", 0) == 0, saved)
    page.focus("#split-preview"); page.keyboard.press("ArrowUp")
    ph3 = page.evaluate("document.querySelector('[data-pane=preview]').getBoundingClientRect().height")
    check("ArrowUp grows details by a step", 10 < ph3 - ph2 < 24, (ph2, ph3))
    page.click("[data-pane-toggle=preview]")
    strip = page.evaluate("document.querySelector('[data-pane=preview]').getBoundingClientRect().height")
    check("collapsed details: 28px strip", abs(strip - 28) <= 1, strip)
    page.click("[data-pane-toggle=preview]")
    send(page, {"type": "displayPrefs", "display": {"detailsLocation": "right"}})
    geo = page.evaluate("""() => { const l = document.querySelector('[data-pane=log]').getBoundingClientRect(), p = document.querySelector('[data-pane=preview]').getBoundingClientRect(); return {lr: l.right, pl: p.left}; }""")
    check("right again: side by side", geo["pl"] >= geo["lr"] - 1 and page.get_attribute("#split-preview", "aria-orientation") == "vertical", geo)

    # auto in a narrow tall panel → bottom (and the preview is not folded away).
    send(page, {"type": "displayPrefs", "display": {}})
    page.set_viewport_size({"width": 520, "height": 760}); page.wait_for_timeout(300)
    bottom = page.eval_on_selector(ws, "e => e.classList.contains('gv-details-bottom')")
    folded = page.eval_on_selector("[data-pane=preview]", "e => e.classList.contains('gv-collapsed')")
    check("narrow tall auto → bottom, details shown", bottom and not folded, (bottom, folded))
    page.set_viewport_size({"width": 520, "height": 330}); page.wait_for_timeout(300)
    check("narrow short → right, details folded", not page.eval_on_selector(ws, "e => e.classList.contains('gv-details-bottom')") and page.eval_on_selector("[data-pane=preview]", "e => e.classList.contains('gv-collapsed')"))
    sw = page.evaluate("document.documentElement.scrollWidth")
    check("no horizontal page scroll at 520", sw <= 520, sw)

    check("no console errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
