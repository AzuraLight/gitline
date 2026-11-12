"""Browser checks for the 1.9.0 working-changes pane (stage / unstage / commit / amend / menus),
against the demo page (tools/demo/mock-host.js keeps an in-memory index).

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoWork.playwright.py http://127.0.0.1:8765/out-demo/index.html
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


def group_paths(page, key):
    return page.locator(f".gv-work-group--{key} .gv-work-file").evaluate_all("els => els.map(e => e.dataset.path)")


def sent(page, kind):
    return page.evaluate("k => window.SENT.filter(m => m.type === k)", kind)


with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    page = b.new_page(viewport={"width": 1400, "height": 820})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector(".gv-virtual-row--working")

    page.click(".gv-virtual-row--working")
    page.wait_for_selector(".gv-work-file")
    check("clicking the row opens the pane, row selected",
          page.locator(".gv-virtual-row--working.gv-virtual-row--selected").count() == 1 and page.locator("#work-message").count() == 1)
    check("no jump to Source Control on click", not sent(page, "focusScm"))
    check("groups: staged 1, changes 3, untracked 1",
          [len(group_paths(page, k)) for k in ("staged", "unstaged", "untracked")] == [1, 3, 1])
    check("commit disabled without a message", page.is_disabled("#btn-work-commit"))

    page.fill("#work-message", "Fix cart total rounding\n\nUse BigDecimal.")
    page.hover(".gv-work-group--unstaged .gv-work-file >> nth=0")
    page.click(".gv-work-group--unstaged .gv-work-file >> nth=0 >> .gv-work-act--stage")
    page.wait_for_timeout(300)
    check("stage one file moves it to Staged", "src/main/java/com/acme/shop/cart/CartTotal.java" in group_paths(page, "staged"))
    check("message kept through the reload", page.input_value("#work-message").startswith("Fix cart total rounding"))
    check("pane still open after the reload", page.locator("#work-groups").count() == 1)

    page.click(".gv-work-group--untracked .gv-detail-files-actions .gv-work-act--stage")
    page.wait_for_timeout(300)
    check("Stage all (group) empties Untracked", group_paths(page, "untracked") == [])
    page.click(".gv-work-group--staged .gv-detail-files-actions .gv-work-act--unstage")
    page.wait_for_timeout(300)
    check("Unstage all empties Staged", group_paths(page, "staged") == [])
    page.click(".gv-work-group--unstaged .gv-work-file >> nth=0")
    d = sent(page, "openWorkDiff")
    check("clicking a file opens its diff with the group", d and d[-1]["group"] == "unstaged", d)

    # Keyboard: Space stages the focused row and focus follows it into Staged.
    page.focus(".gv-work-group--unstaged .gv-work-file >> nth=0")
    first = page.get_attribute(".gv-work-group--unstaged .gv-work-file >> nth=0", "data-path")
    page.keyboard.press(" ")
    page.wait_for_timeout(300)
    check("Space stages; focus stays on the file",
          page.evaluate("document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.path : null") == first)

    page.focus("#work-message")
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(300)
    c = sent(page, "workCommit")
    check("Ctrl+Enter commits with the message", c and c[-1]["message"].startswith("Fix cart total") and c[-1]["amend"] is False, c)
    check("after commit: message cleared, button ready", page.input_value("#work-message") == "" and page.is_disabled("#btn-work-commit"))

    page.check("#work-amend")
    page.wait_for_timeout(200)
    check("amend fills the last message", page.input_value("#work-message") == "Tighten CORS for the admin API")
    check("amend warns when pushed", "force push" in (page.text_content("#work-error") or ""))
    check("button reads Amend", page.text_content("#btn-work-commit").strip() == "Amend")
    page.uncheck("#work-amend")
    check("unchecking restores what was typed (empty)", page.input_value("#work-message") == "")

    page.click(".gv-virtual-row--working", button="right")
    labels = page.locator("#ctx-menu button").all_text_contents()
    check("row menu: stash, discard all, delete untracked, source control",
          any("Stash" in l for l in labels) and any("Discard all" in l for l in labels) and any("untracked" in l for l in labels), labels)
    page.keyboard.press("Escape")

    # Another commit row selected → back to the commit view; the working row is not selected.
    page.click(".gv-commit-log-row >> nth=0")
    page.wait_for_timeout(200)
    check("selecting a commit leaves the pane", page.locator("#work-message").count() == 0)
    check("no page errors", not errors, errors)
    page.close()

    # Repository without commits but with files: the working row is there for the first commit.
    narrow = b.new_page(viewport={"width": 360, "height": 760})
    narrow.add_init_script("window.__GV_DEMO_WORK__ = " + json.dumps({"staged": [], "unstaged": [], "untracked": [{"path": "very/long/path/to/a/file/that/needs/room/settings.json", "status": "?"}], "conflicted": []}) + ";")
    narrow.goto(URL)
    narrow.wait_for_selector(".gv-virtual-row--working")
    narrow.click(".gv-virtual-row--working")
    narrow.wait_for_timeout(300)
    sw = narrow.evaluate("document.documentElement.scrollWidth")
    check("no horizontal scroll at 360px", sw <= 360, sw)
    narrow.close()
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
