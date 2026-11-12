"""Browser edge cases for the 1.9.0 working-changes pane, against the demo page
(tools/demo/mock-host.js; initial files from window.__GV_DEMO_WORK__).

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoWorkEdge.playwright.py http://127.0.0.1:8765/out-demo/index.html
Prints one PASS/FAIL line per check; exit code 1 when any check fails.
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(info)) if info and not ok else ""))


def open_pane(browser, work, width=1400, height=820):
    page = browser.new_page(viewport={"width": width, "height": height})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    if work is not None:
        page.add_init_script("window.__GV_DEMO_WORK__ = " + json.dumps(work) + ";")
    page.goto(URL)
    page.wait_for_selector(".gv-virtual-row--working")
    page.click(".gv-virtual-row--working")
    page.wait_for_selector("#work-groups")
    page.wait_for_timeout(200)
    return page, errors


def sent(page, kind):
    return page.evaluate("k => window.SENT.filter(m => m.type === k)", kind)


def active(page):
    return page.evaluate("""() => { const e = document.activeElement; if (!e) return '';
      return e.id || (e.dataset && e.dataset.path ? 'row:' + e.dataset.path : '') || e.className; }""")


def empty(**groups):
    w = {"staged": [], "unstaged": [], "untracked": [], "conflicted": []}
    w.update(groups)
    return w


with sync_playwright() as p:
    b = p.chromium.launch()

    # 1. 300 files: drawn quickly, scrolls, no errors.
    many = empty(unstaged=[{"path": f"src/module{i // 20}/file-{i:03}.ts", "status": "M"} for i in range(300)])
    t0 = time.time()
    page, errors = open_pane(b, many)
    page.wait_for_function("document.querySelectorAll('.gv-work-file').length === 300")
    took = time.time() - t0
    check("300 files listed", page.locator(".gv-work-file").count() == 300)
    check("300 files drawn within 3s (page load included)", took < 3, f"{took:.2f}s")
    page.locator(".gv-work-file >> nth=299").scroll_into_view_if_needed()
    check("last of 300 reachable by scrolling", page.locator(".gv-work-file >> nth=299").is_visible())
    t1 = time.time()
    page.click(".gv-work-group--unstaged .gv-detail-files-actions .gv-work-act--stage")
    page.wait_for_function("document.querySelectorAll('.gv-work-group--staged .gv-work-file').length === 300")
    check("stage all 300 redraws within 2s", time.time() - t1 < 2, f"{time.time() - t1:.2f}s")
    check("no page errors (300 files)", not errors, errors)
    page.close()

    # 2. Very long names at 320px: no horizontal scroll, the file name stays visible.
    long_name = "a-very-long-file-name-that-goes-on-and-on-and-on-forever-and-ever.properties"
    longw = empty(untracked=[{"path": "deep/" * 12 + long_name, "status": "?"}],
                  staged=[{"path": "src/" + "x" * 120 + ".ts", "status": "R", "orig": "src/old-" + "y" * 80 + ".ts"}])
    page, errors = open_pane(b, longw, width=320, height=760)
    sw = page.evaluate("document.documentElement.scrollWidth")
    check("no horizontal scroll at 320px with long names", sw <= 320, sw)
    name_box = page.locator(".gv-work-group--untracked .gv-work-path__name").bounding_box()
    check("file name starts inside the pane at 320px", name_box and name_box["x"] < 320, name_box)
    check("full path in the tooltip", page.get_attribute(".gv-work-group--untracked .gv-work-path", "title").endswith(long_name))
    check("no page errors (320px)", not errors, errors)
    page.close()

    # 3. Keyboard: Tab order message → amend → commit → file rows; Space / Enter on rows.
    page, errors = open_pane(b, None)
    page.focus("#work-message")
    page.fill("#work-message", "msg")
    order = [active(page)]
    for _ in range(5):
        page.keyboard.press("Tab")
        order.append(active(page))
    # Screen order: the group's own "unstage all" button sits in its header, above its rows.
    check("Tab: message → amend → commit → group button → first file row → its button",
          order[0] == "work-message" and order[1] == "work-amend" and order[2] == "btn-work-commit"
          and "gv-work-act" in order[3] and order[4].startswith("row:") and "gv-work-act" in order[5], order)
    first_unstaged = page.get_attribute(".gv-work-group--unstaged .gv-work-file >> nth=0", "data-path")
    page.focus(".gv-work-group--unstaged .gv-work-file >> nth=0")
    page.keyboard.press("Enter")
    d = sent(page, "openWorkDiff")
    check("Enter on a row opens its diff", d and d[-1]["path"] == first_unstaged, d)
    before = len(sent(page, "workStage"))
    page.keyboard.press("Tab")  # onto the row's discard button
    page.keyboard.press("Enter")
    check("Enter on the row's discard button discards (not a diff, not a stage)",
          len(sent(page, "workDiscardFile")) == 1 and len(sent(page, "workStage")) == before and len(sent(page, "openWorkDiff")) == 1)
    check("no page errors (keyboard)", not errors, errors)
    page.close()

    # 4. Double-click Commit: one workCommit.
    page, errors = open_pane(b, None)
    page.fill("#work-message", "once")
    page.evaluate("() => { const b = document.getElementById('btn-work-commit'); b.click(); b.click(); b.click(); }")
    page.wait_for_timeout(300)
    check("triple-click Commit sends one workCommit", len(sent(page, "workCommit")) == 1, sent(page, "workCommit"))
    page.close()

    # 5. Amend toggled on and off repeatedly: the typed text comes back each time.
    page, errors = open_pane(b, None)
    page.fill("#work-message", "my own text")
    ok = True
    for _ in range(4):
        page.check("#work-amend")
        page.wait_for_timeout(120)
        ok = ok and page.input_value("#work-message") == "Tighten CORS for the admin API"
        page.uncheck("#work-amend")
        ok = ok and page.input_value("#work-message") == "my own text"
    check("amend on/off ×4 restores the typed text", ok, page.input_value("#work-message"))
    check("unchecking clears the pushed warning", not page.is_visible("#work-error"))
    page.close()

    # 6. A workError while the pane is closed changes nothing and throws nothing.
    page, errors = open_pane(b, None)
    page.click(".gv-commit-log-row >> nth=0")
    page.evaluate("m => window.postMessage(m, '*')", {"type": "workError", "message": "late error"})
    page.evaluate("m => window.postMessage(m, '*')", {"type": "workFiles", "files": empty()})
    page.wait_for_timeout(150)
    check("late workError / workFiles with the pane closed: no errors, commit view kept",
          not errors and page.locator("#work-message").count() == 0, errors)
    page.close()

    # 7. Switching to a commit and back keeps the draft (same repository).
    page, errors = open_pane(b, None)
    page.fill("#work-message", "draft survives")
    page.click(".gv-commit-log-row >> nth=2")
    page.wait_for_timeout(150)
    page.click(".gv-virtual-row--working")
    page.wait_for_selector("#work-message")
    check("draft kept after visiting a commit", page.input_value("#work-message") == "draft survives")
    # A list from another repository (late answer after a switch) is ignored.
    page.evaluate("m => window.postMessage(m, '*')", {"type": "workFiles", "root": "/somewhere/else", "files": empty(untracked=[{"path": "foreign.txt", "status": "?"}])})
    page.wait_for_timeout(150)
    check("a file list from another repository is ignored", page.locator("[data-path='foreign.txt']").count() == 0)
    page.close()

    # 8. Conflicts only: listed with a note, no stage / discard buttons on them.
    page, errors = open_pane(b, empty(conflicted=[{"path": "src/a.ts", "status": "U"}, {"path": "src/b.ts", "status": "U"}]))
    check("conflicted files listed", page.locator(".gv-work-group--conflicted .gv-work-file").count() == 2)
    check("no buttons on conflicted rows", page.locator(".gv-work-group--conflicted .gv-work-act").count() == 0)
    check("conflict note shown", page.locator(".gv-work-group--conflicted .gv-work-note").count() == 1)
    page.focus(".gv-work-group--conflicted .gv-work-file >> nth=0")
    page.keyboard.press(" ")
    check("Space on a conflicted row stages nothing", len(sent(page, "workStage")) == 0)
    check("no page errors (conflicts)", not errors, errors)
    page.close()

    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
