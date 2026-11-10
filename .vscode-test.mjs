// Integration tests: launches a real VS Code with this extension loaded (@vscode/test-cli).
//   npm run test:integration           → current stable VS Code
//   npm run test:integration:minimum   → the oldest VS Code that package.json's engines.vscode allows
//   npm run test:integration:no-git-ext → stable VS Code with the built-in Git extension disabled
import { readFileSync } from "node:fs";
import { defineConfig } from "@vscode/test-cli";

// "^1.85.0" → "1.85.0": the minimum version comes from engines.vscode, so the two never drift apart.
const engines = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).engines.vscode;
const minimumVersion = engines.replace(/^[^\d]*/, "");

const common = {
  files: "out-test/test/integration/**/*.test.js",
  mocha: { ui: "bdd", timeout: 60_000 },
};

export default defineConfig([
  { label: "stable", version: "stable", launchArgs: ["--disable-extensions"], ...common },
  { label: "minimum", version: minimumVersion, launchArgs: ["--disable-extensions"], ...common },
  // Gitline must work where the built-in Git extension is not loaded in its extension host —
  // e.g. a Remote SSH window (issue: "depends on the Git extension, which is not loaded").
  // Only this flag: together with --disable-extensions, VS Code ignores --disable-extension.
  {
    label: "no-git-ext",
    version: "stable",
    launchArgs: ["--disable-extension", "vscode.git"],
    env: { GITLINE_TEST_NO_GIT_EXTENSION: "1" },
    ...common,
  },
]);
