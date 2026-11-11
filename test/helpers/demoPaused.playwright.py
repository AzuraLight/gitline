"""Browser checks for the 1.8.0 paused-operation banner (merge / rebase / cherry-pick / revert),
against the demo page (tools/demo/mock-host.js, state from window.__GV_DEMO_PAUSED__).

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoPaused.playwright.py http://127.0.0.1:8765/out-demo/index.html
Prints one PASS/FAIL line per check; exit code 1 when any check fails.
"""
import json
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(info)) if info and not ok else ""))


def open_page(browser, paused, width=1200):
    page = browser.new_page(viewport={"width": width, "height": 640})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("window.__GV_DEMO_PAUSED__ = " + json.dumps(paused) + ";")
    page.goto(URL)
    page.wait_for_selector(".gv-commit-log-row")
    page.wait_for_timeout(150)
    return page, errors


def visible(page, sel):
    return page.evaluate("s => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null; }", sel)


MERGE = {"kind": "merge", "subject": "Merge branch 'feature/checkout'", "step": 0, "total": 0,
         "conflicted": ["src/main/java/com/acme/shop/checkout/CheckoutService.java", "한글 파일.txt"]}

with sync_playwright() as p:
    b = p.chromium.launch()

    page, errors = open_page(b, None)
    check("nothing paused: no banner", not visible(page, "#op-banner"))
    page.close()

    page, errors = open_page(b, MERGE)
    text = page.text_content("#op-banner-text")
    check("merge: banner text", "Merging: Merge branch 'feature/checkout'" in text and "2 conflicted" in text, text)
    check("merge: no Skip button", not visible(page, "#btn-op-skip"))
    check("merge: Continue and Abort shown", visible(page, "#btn-op-continue") and visible(page, "#btn-op-abort"))
    files = page.locator("#op-banner-files button").all_text_contents()
    check("conflicted files listed (non-ASCII kept)", files == MERGE["conflicted"], files)
    page.click("#op-banner-files button >> nth=1")
    sent = page.evaluate("window.SENT.filter(m => m.type === 'openConflict')")
    check("clicking a file asks to open it", sent and sent[-1]["path"] == "한글 파일.txt", sent)
    page.evaluate("() => { const b = document.getElementById('btn-op-continue'); b.click(); b.click(); }")
    check("double click: buttons wait while a step runs", page.is_disabled("#btn-op-abort"))
    page.wait_for_timeout(200)
    sent = page.evaluate("window.SENT.filter(m => m.type === 'pausedStep')")
    check("double click sends one step", len(sent) == 1, sent)
    check("answer frees the buttons", not page.is_disabled("#btn-op-continue"))
    check("continue posts kind + step", sent and sent[-1] == {"type": "pausedStep", "kind": "merge", "step": "continue"}, sent)
    check("refusal shown in the banner", visible(page, "#op-banner-detail") and "still have conflicts" in page.text_content("#op-banner-detail"))
    check("banner still up", visible(page, "#op-banner"))
    page.click("#btn-op-abort")
    page.wait_for_timeout(400)
    check("abort: banner gone after reload", not visible(page, "#op-banner"))
    check("abort: message cleared", not visible(page, "#op-banner-detail"))
    check("no page errors (merge)", not errors, errors)
    page.close()

    rebase = {"kind": "rebase", "subject": "feature/search", "step": 2, "total": 5, "conflicted": []}
    page, errors = open_page(b, rebase)
    text = page.text_content("#op-banner-text")
    check("rebase: branch, progress, resolved hint", "Rebasing feature/search" in text and "step 2 of 5" in text and "No conflicts left" in text, text)
    check("rebase: Skip shown", visible(page, "#btn-op-skip"))
    check("no conflicts: file list hidden", not visible(page, "#op-banner-files"))
    page.click("#btn-op-skip")
    page.wait_for_timeout(400)
    sent = page.evaluate("window.SENT.filter(m => m.type === 'pausedStep')")
    check("skip posts rebase/skip", sent and sent[-1]["step"] == "skip" and sent[-1]["kind"] == "rebase", sent)
    check("skip ended it: banner gone", not visible(page, "#op-banner"))
    page.close()

    many = {"kind": "cherry-pick", "subject": "Fix 한글 product names", "step": 0, "total": 0,
            "conflicted": ["dir/file-%02d.txt" % i for i in range(27)]}
    page, errors = open_page(b, many, width=360)
    text = page.text_content("#op-banner-text")
    check("cherry-pick text", text.startswith("Cherry-picking: Fix 한글 product names"), text)
    check("27 files: 20 shown + '+7'", page.locator("#op-banner-files button").count() == 20 and "+7" in page.text_content("#op-banner-files"))
    h = page.evaluate("document.getElementById('op-banner-files').getBoundingClientRect().height")
    check("long file list capped in height", h < 120, h)
    sw = page.evaluate("document.documentElement.scrollWidth")
    check("no horizontal scroll at 360px", sw <= 360, sw)
    check("no page errors (narrow)", not errors, errors)
    page.close()

    rev = {"kind": "revert", "subject": "Tighten CORS", "step": 0, "total": 0, "conflicted": ["a.txt"]}
    page, errors = open_page(b, rev)
    check("revert text", page.text_content("#op-banner-text").startswith("Reverting: Tighten CORS"))
    # A different kind than shown (stale banner): the mock answers done + reload, as the host does.
    page.evaluate("m => window.postMessage(m, '*')", {"type": "opError", "message": "boom"})
    page.wait_for_timeout(100)
    check("opError message shows", page.text_content("#op-banner-detail") == "boom")
    page.evaluate("m => window.postMessage(m, '*')", {"type": "opDone"})
    page.wait_for_timeout(100)
    check("opDone clears the message", not visible(page, "#op-banner-detail"))
    page.close()

    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
