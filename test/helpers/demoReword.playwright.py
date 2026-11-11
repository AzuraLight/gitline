"""Browser checks for reword in the interactive rebase editor (issue #4), against the demo page.

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoReword.playwright.py http://127.0.0.1:8765/out-demo/index.html
Prints one PASS/FAIL line per check; exit code 1 when any check fails.
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(info)) if info and not ok else ""))


def open_editor(page):
    page.goto(URL)
    page.wait_for_selector(".gv-commit-log-row")
    page.click(".gv-commit-log-row >> nth=3", button="right")
    page.click("#ctx-menu button:has-text('Interactive rebase')")
    page.wait_for_selector(".gv-rebase-row")


with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    page = b.new_page(viewport={"width": 1400, "height": 760})
    page.on("pageerror", lambda e: errors.append(str(e)))
    open_editor(page)

    opts = page.locator(".gv-rebase-row >> nth=0").locator("select option").all_text_contents()
    check("actions include reword (after pick)", opts[:2] == ["pick", "reword"], opts)
    check("no message box while all are pick", page.locator(".gv-rebase-reword__input").count() == 0)

    page.select_option(".gv-rebase-row >> nth=0 >> select", "reword")
    ta = page.locator(".gv-rebase-reword__input")
    check("reword opens one message box", ta.count() == 1)
    value = ta.input_value()
    check("prefilled with the full original message", "\n\nDetails of " in value, value)
    check("focus goes to the message", page.evaluate("document.activeElement.classList.contains('gv-rebase-reword__input')"))
    check("message box is labelled", "Commit message" in (ta.get_attribute("aria-label") or ""))

    ta.fill("   ")
    check("blank message: Apply disabled", page.is_disabled("#btn-rebase-apply"))
    check("blank message: box marked", "gv-rebase-reword__input--empty" in (ta.get_attribute("class") or ""))
    new_msg = 'Fix "typo" in b\'s title\n\n한글 본문'
    ta.fill(new_msg)
    check("message typed: Apply enabled", not page.is_disabled("#btn-rebase-apply"))

    # Moving rows keeps the typed message with its commit.
    page.click(".gv-rebase-row >> nth=0 >> button[title='Move down']")
    check("moved row keeps its message", page.locator(".gv-rebase-reword__input").input_value() == new_msg)
    page.click(".gv-rebase-row >> nth=1 >> button[title='Move up']")

    page.click("#btn-rebase-apply")
    page.wait_for_timeout(200)
    sent = page.evaluate("window.SENT.filter(m => m.type === 'applyRebase')")
    items = sent[-1]["items"] if sent else []
    check("apply sends the reword with its message", items and items[0]["action"] == "reword" and items[0]["message"] == new_msg, items[:1])
    check("other rows carry no message", all("message" not in it for it in items[1:]), items[1:3])

    # Switching back to pick hides the box; picking reword again restores what was typed.
    open_editor(page)
    page.select_option(".gv-rebase-row >> nth=1 >> select", "reword")
    page.locator(".gv-rebase-reword__input").fill("draft")
    page.select_option(".gv-rebase-row >> nth=1 >> select", "pick")
    check("back to pick: box gone", page.locator(".gv-rebase-reword__input").count() == 0)
    page.select_option(".gv-rebase-row >> nth=1 >> select", "reword")
    check("reword again: draft kept", page.locator(".gv-rebase-reword__input").input_value() == "draft")
    check("no page errors", not errors, errors)
    page.close()

    narrow = b.new_page(viewport={"width": 360, "height": 700})
    narrow.goto(URL)
    narrow.wait_for_selector(".gv-commit-log-row")
    narrow.click(".gv-commit-log-row >> nth=3", button="right")
    narrow.click("#ctx-menu button:has-text('Interactive rebase')")
    narrow.wait_for_timeout(300)
    if narrow.locator(".gv-rebase-row").count():
        narrow.select_option(".gv-rebase-row >> nth=0 >> select", "reword")
    sw = narrow.evaluate("document.documentElement.scrollWidth")
    check("no horizontal scroll at 360px", sw <= 360, sw)
    narrow.close()
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
