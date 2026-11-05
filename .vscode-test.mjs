// Integration tests: launches a real VS Code with this extension loaded (@vscode/test-cli).
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out-test/test/integration/**/*.test.js",
  version: "stable",
  mocha: { ui: "bdd", timeout: 60_000 },
  launchArgs: ["--disable-extensions"],
});
