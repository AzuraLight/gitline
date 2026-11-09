"""Static server for the README demo (out-demo/index.html), run from the repo root.

    python3 tools/demo/serve.py [port]        # default 8790

`python3 -m http.server` listens with a backlog of 5. The demo page requests ~25 scripts and
stylesheets at once on its first load, so a fresh server refuses some of them and the page comes
up without its graph (e.g. graphSvg.js fails with ERR_SOCKET_NOT_CONNECTED). A deeper queue fixes it.
"""
import http.server
import sys


class DemoServer(http.server.ThreadingHTTPServer):
    request_queue_size = 128


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    handler = http.server.SimpleHTTPRequestHandler
    with DemoServer(("127.0.0.1", port), handler) as server:
        print(f"serving the repo root on http://localhost:{port}/out-demo/index.html")
        server.serve_forever()


if __name__ == "__main__":
    main()
