// Integration tests: launches a real VS Code with this extension loaded (@vscode/test-cli).
//   npm run test:integration           → current stable VS Code
//   npm run test:integration:minimum   → the oldest VS Code that package.json's engines.vscode allows
import { readFileSync } from "node:fs";
import { defineConfig } from "@vscode/test-cli";

// "^1.85.0" → "1.85.0": the minimum version comes from engines.vscode, so the two never drift apart.
const engines = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).engines.vscode;
const minimumVersion = engines.replace(/^[^\d]*/, "");

const common = {
  files: "out-test/test/integration/**/*.test.js",
  mocha: { ui: "bdd", timeout: 60_000 },
  launchArgs: ["--disable-extensions"],
};

export default defineConfig([
  { label: "stable", version: "stable", ...common },
  // extensionDependencies is only vscode.git, which ships inside VS Code. Older VS Code builds try
  // to fetch it from the Marketplace and fail ("Extension 'vscode.git' not found"), so skip that.
  { label: "minimum", version: minimumVersion, skipExtensionDependencies: true, ...common },
]);
