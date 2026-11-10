"""Browser edge cases for the 1.6.0 repository picker, against the demo page (tools/demo/mock-host.js).

Run (from the repo root, after `npm run compile && node tools/demo/build.js list`):
    python3 -I tools/demo/serve.py 8765 &
    <playwright python> test/helpers/demoPicker.playwright.py http://127.0.0.1:8765/out-demo/index.html
Prints one PASS/FAIL line per check; exit code 1 when any check fails.
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
results = []


def check(name, cond, info=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info and not cond else ""))


def item(i, group="workspace"):
    return {"path": f"/r/repo{i}", "name": f"repo{i}", "detail": "r", "group": group}


def push_list(page, items, selected="/r/repo0"):
    page.evaluate("([items, sel]) => window.postMessage({type:'repoList', items, selectedRepo: sel}, '*')", [items, selected])
    page.wait_for_timeout(100)


def open_menu(page):
    page.click("#repo-path")
    page.wait_for_timeout(150)


def visible_items(page):
    return page.eval_on_selector_all("#repo-menu button.gv-repo-menu__item:not([hidden]):not(.gv-repo-menu__action)", "bs => bs.filter(b => b.offsetParent).map(b => b.querySelector('.gv-repo-menu__name').textContent)")


def focused_text(page):
    return page.evaluate("() => (document.activeElement.querySelector('.gv-repo-menu__name')||document.activeElement).textContent || document.activeElement.className")


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1000, "height": 700})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("#repo-path:not(:empty)")

    # 7 entries from the mock: filter shown, refreshRepos sent once per open.
    open_menu(page)
    check("menu opens", page.is_visible("#repo-menu"))
    check("7 entries show a filter", page.locator(".gv-repo-menu__filter").count() == 1)
    check("filter focused on open", page.evaluate("() => document.activeElement.classList.contains('gv-repo-menu__filter')"))
    n7 = len(visible_items(page))
    check("7 entries listed", n7 == 7, str(n7))
    check("refreshRepos posted on open", page.evaluate("() => SENT.filter(m => m.type==='refreshRepos').length") == 1)

    # Filter + keyboard.
    page.keyboard.type("json")
    check("filter narrows to json-*", visible_items(page) == ["json-editor", "json-viewer"], str(visible_items(page)))
    page.keyboard.press("ArrowUp")
    check("ArrowUp from the filter goes to the first match", focused_text(page) == "json-editor", focused_text(page))
    page.keyboard.press("ArrowUp")
    check("ArrowUp at the top stays on the first entry", focused_text(page) == "json-editor", focused_text(page))
    page.keyboard.press("End")
    last = focused_text(page)
    page.keyboard.press("Home")
    check("Home jumps to first", focused_text(page) == "json-editor", focused_text(page))
    check("End jumps to the last button (the 'Clear recent' action, since a recent entry exists)", "Clear" in last, last)
    page.click(".gv-repo-menu__filter")
    page.keyboard.press("Home")
    check("Home inside the filter moves the caret, not focus", page.evaluate("() => document.activeElement.tagName") == "INPUT")
    page.fill(".gv-repo-menu__filter", "zzz-nothing")
    check("no-match message shown", page.is_visible(".gv-repo-menu__empty"))

    # repoList arriving while the filter has text keeps the filter (and its focus).
    page.fill(".gv-repo-menu__filter", "editor")
    push_list(page, page.evaluate("() => null") or [
        {"path": "/Users/demo/acme-shop/research/json-editor", "name": "json-editor", "detail": "x", "group": "workspace"},
        {"path": "/Users/demo/acme-shop/research/text-editor", "name": "text-editor", "detail": "x", "group": "workspace"},
    ] + [item(i) for i in range(5)], "/Users/demo/acme-shop")
    check("filter text kept after repoList", page.input_value(".gv-repo-menu__filter") == "editor")
    check("filter still applied after repoList", visible_items(page) == ["json-editor", "text-editor"], str(visible_items(page)))
    check("filter keeps focus after repoList", page.evaluate("() => document.activeElement.classList.contains('gv-repo-menu__filter')"))

    # Escape returns focus to the badge.
    page.keyboard.press("Escape")
    check("Escape closes", not page.is_visible("#repo-menu"))
    check("focus returns to the badge", page.evaluate("() => document.activeElement.id") == "repo-path")

    # Reopen: filter is cleared.
    open_menu(page)
    check("filter cleared on reopen", page.input_value(".gv-repo-menu__filter") == "")

    # Clicking outside closes.
    page.mouse.click(900, 650)
    check("click outside closes", not page.is_visible("#repo-menu"))

    # Repeated open/close does not duplicate entries.
    for _ in range(6):
        open_menu(page)
        page.keyboard.press("Escape")
    open_menu(page)
    n = len(visible_items(page))
    secs = page.locator("#repo-menu .gv-repo-menu__section").count()
    check("no duplicates after repeated open/close", n == 7 and secs == 2, f"{n} items, {secs} sections")
    check("one filter after repeated open/close", page.locator(".gv-repo-menu__filter").count() == 1)

    # 0 and 1 entries (pushed while open).
    push_list(page, [], "")
    check("0 entries: no filter", page.locator(".gv-repo-menu__filter").count() == 0)
    check("0 entries: no repo items, 'Open another' still there", len(visible_items(page)) == 0 and page.is_visible(".gv-repo-menu__open"))
    check("0 entries: no 'Clear recent'", page.locator(".gv-repo-menu__clear").count() == 0)
    # BUG: the re-render removed the focused filter; focus falls to <body>, so the menu's keydown
    # handler (media/webview/main.js:319) never sees the arrow keys and Escape no longer closes it.
    check("0 entries pushed while the filter had focus: focus stays inside the menu",
          page.evaluate("() => document.getElementById('repo-menu').contains(document.activeElement)"),
          page.evaluate("() => document.activeElement.tagName"))
    page.keyboard.press("ArrowDown")
    check("0 entries: ArrowDown reaches 'Open another'", "gv-repo-menu__open" in page.evaluate("() => document.activeElement.className"))
    push_list(page, [item(0)])
    check("1 entry: listed, marked active, no filter", visible_items(page) == ["repo0"] and page.locator(".gv-repo-menu__item--active").count() == 1 and page.locator(".gv-repo-menu__filter").count() == 0)
    push_list(page, [item(i) for i in range(30)] + [item(99, "recent")])
    check("31 entries: all listed with filter + clear recent", len(visible_items(page)) == 31 and page.locator(".gv-repo-menu__clear").count() == 1)

    # Clear recent posts the message and the mock answers without recents.
    page.mouse.click(900, 650)  # close by clicking outside (Escape may not reach the menu, see BUG above)
    open_menu(page)
    page.click(".gv-repo-menu__clear")
    check("clearRecentRepos posted", page.evaluate("() => SENT.some(m => m.type==='clearRecentRepos')"))
    page.wait_for_timeout(150)
    if not page.is_visible("#repo-menu"):
        open_menu(page)
    check("recent section gone after clear", page.locator(".gv-repo-menu__clear").count() == 0)

    # BUG: with 6 or fewer entries there is no filter; opening focuses the active entry, then the
    # host's repoList answer to refreshRepos re-renders the menu (main.js:450 → renderRepoMenu(false)
    # empties it at main.js:269) and the focused button is destroyed: focus falls to <body>.
    page.mouse.click(900, 650)
    open_menu(page)
    page.wait_for_timeout(300)  # let the refreshRepos answer arrive
    check("6 entries: no filter", page.locator(".gv-repo-menu__filter").count() == 0)
    check("6 entries: keyboard focus still inside the menu after the refreshRepos answer",
          page.evaluate("() => document.getElementById('repo-menu').contains(document.activeElement)"),
          page.evaluate("() => document.activeElement.tagName"))

    # Selecting an entry posts selectRepo with its path.
    page.locator("#repo-menu button.gv-repo-menu__item", has_text="json-viewer").click()
    page.wait_for_timeout(300)
    sel = page.evaluate("() => SENT.filter(m => m.type==='selectRepo').pop()")
    check("selectRepo posted with path", sel and sel.get("root", "").endswith("json-viewer"), str(sel))

    # Narrow window: the menu stays inside the viewport.
    for w in (420, 320):
        page.set_viewport_size({"width": w, "height": 600})
        page.wait_for_timeout(100)
        if page.is_visible("#repo-menu"):
            page.mouse.click(5, 590)
        closed_sw = page.evaluate("() => document.documentElement.scrollWidth")
        open_menu(page)
        box = page.eval_on_selector("#repo-menu", "m => { const r = m.getBoundingClientRect(); return [r.left, r.right, r.bottom, innerWidth, innerHeight, document.documentElement.scrollWidth]; }")
        check(f"menu inside a {w}px window (horizontally)", box[0] >= 0 and box[1] <= box[3] + 0.5, str(box))
        check(f"menu bottom inside a {w}px window", box[2] <= box[4], str(box))
        # The demo page itself overflows at 420px even with the menu closed (scrollWidth 490), so only
        # check that opening the menu adds no horizontal scroll.
        check(f"opening the menu adds no horizontal scroll at {w}px", box[5] <= max(closed_sw, box[3]), f"closed {closed_sw}, {box}")
        page.mouse.click(5, 590)

    check("no page errors", not errors, "; ".join(errors))
    b.close()

sys.exit(0 if all(ok for _, ok in results) else 1)
