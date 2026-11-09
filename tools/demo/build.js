// Builds out-demo/index.html: the real webview shell with English strings, a VS Code theme and a
// mock host, so it opens in any browser. Used to record README screenshots and GIFs.
//
//   npm run compile && node tools/demo/build.js [list|tree]
//   python3 tools/demo/serve.py 8790   # from the repo root (not `-m http.server`: see serve.py)
//   open http://localhost:8790/out-demo/index.html?theme=dark
"use strict";
const fs = require("fs");
const path = require("path");
const Module = require("module");

const root = path.resolve(__dirname, "../..");

/** Just enough of the `vscode` module for commitGraphView.ts and nls.ts. */
const vscodeStub = {
  Uri: { joinPath: (base, ...parts) => path.join(base, ...parts) },
  l10n: { t: (s, ...args) => s.replace(/\{(\d+)\}/g, (m, i) => (args.length > Number(i) ? String(args[Number(i)]) : m)) },
  env: { language: "en" },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};

const { buildCommitGraphShellHtml } = require(path.join(root, "out/commitGraphView.js"));
const { getCommitGraphWebviewUi } = require(path.join(root, "out/nls.js"));

const webview = {
  cspSource: "",
  asWebviewUri: (p) => "/" + path.relative(root, p).split(path.sep).join("/"),
};
const fileView = process.argv[2] === "tree" ? "tree" : "list";
let html = buildCommitGraphShellHtml(webview, root, getCommitGraphWebviewUi(), "en", { fileView });

html = html
  // The demo is served over http; the webview CSP only allows VS Code's resource scheme.
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<html ", "<html data-theme=\"dark\" ")
  .replace("</head>", '  <link rel="stylesheet" href="/tools/demo/theme.css" />\n' +
    "  <script>document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';</script>\n" +
    '  <script src="/tools/demo/mock-host.js"></script>\n</head>');

fs.mkdirSync(path.join(root, "out-demo"), { recursive: true });
fs.writeFileSync(path.join(root, "out-demo/index.html"), html);
console.log("out-demo/index.html (" + fileView + " view)");
