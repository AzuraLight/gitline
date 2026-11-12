"""1.10.0 final review: a graphError carries no requestId, so the stale-reply guard does not cover it.
A late error from an older request wipes a newer, already drawn list.

Run: <playwright python> -I test/helpers/demoStaleError1100final.playwright.py http://127.0.0.1:8765/out-demo/index.html
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/out-demo/index.html"
results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("  -- " + str(info) if info != "" else ""))


SEND = """([n, tag, extra]) => new Promise(res => {
  const h = i => ('0000000000000000000000000000000000000000' + i.toString(16)).slice(-40);
  const cs = [];
  for (let i = 0; i < n; i++) cs.push({ hash: h(i), shortHash: h(i).slice(-7), parents: i === n - 1 ? [] : [h(i + 1)], subject: tag + ' ' + i, author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', refs: [] });
  window.__LOCK = true;
  const pl = Object.assign({}, window.__T, { commits: cs, viewRev: '', requestedRevs: [] }, extra || {});
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'graphPayload', payload: pl, ours: true } }));
  setTimeout(res, 200); })"""

ERR = """([msg, extra]) => new Promise(res => {
  window.dispatchEvent(new MessageEvent('message', { data: Object.assign({ type: 'graphError', code: 'git', message: msg, ours: true }, extra || {}) }));
  setTimeout(res, 200); })"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1400, "height": 820})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("""window.addEventListener('message', ev => {
      if (!ev.data || (ev.data.type !== 'graphPayload' && ev.data.type !== 'graphError')) return;
      if (ev.data.type === 'graphPayload' && !window.__T) { window.__T = ev.data.payload; return; }
      if (window.__LOCK && !ev.data.ours) ev.stopImmediatePropagation();
    }, true);""")
    page.goto(URL)
    page.wait_for_function("!!window.__T")

    # A scroll request (older) fails slowly; the search typed after it (newer) answers first.
    page.fill("#search-input", "match")
    page.wait_for_function("window.SENT.filter(m => m.type === 'requestGraph').length >= 2")
    page.wait_for_timeout(400)
    latest = page.evaluate("Math.max(...window.SENT.filter(m => m.type === 'requestGraph').map(m => m.requestId))")
    page.evaluate(SEND, [3, "match", {"query": "match", "requestId": latest}])
    rows_before = page.evaluate("document.querySelectorAll('.gv-commit-log-row').length")
    session = page.evaluate("window.SENT.filter(m => m.type === 'requestGraph').pop().session")
    page.evaluate(ERR, ["fatal: older request failed", {"requestId": latest - 1, "session": session}])
    rows_after = page.evaluate("document.querySelectorAll('.gv-commit-log-row').length")
    check("newer list was drawn", rows_before == 3, rows_before)
    check("a late error from an older request leaves the newer list alone", rows_after == rows_before,
          f"rows {rows_before} -> {rows_after}")
    # A reply from before a webview reload: its numbers may be higher, its session is not ours.
    page.evaluate(SEND, [400, "old-session", {"requestId": latest + 50, "session": "not-this-page"}])
    first = page.evaluate("(document.querySelector('.gv-commit-log-row') || {}).textContent || ''")
    check("a reply from a previous page load is dropped", "match" in first, first[:40])
    # The error for the latest request is shown.
    page.evaluate(ERR, ["fatal: this one failed", {"requestId": latest, "session": session}])
    card = page.evaluate("document.body.innerText.includes('this one failed')")
    check("an error for the latest request is shown", card)
    check("no page errors", not errors, errors)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
