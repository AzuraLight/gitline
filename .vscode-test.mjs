// Integration tests: launches a real VS Code with this extension loaded (@vscode/test-cli).
//   npm run test:integration            → current stable VS Code
//   npm run test:integration:minimum    → the oldest VS Code that package.json's engines.vscode allows
//   npm run test:integration:no-git-ext → stable VS Code with the built-in Git extension disabled
//   npm run test:integration:multi-repo → a workspace folder that is no repository, with repositories below it
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const here = dirname(fileURLToPath(import.meta.url));

// "^1.85.0" → "1.85.0": the minimum version comes from engines.vscode, so the two never drift apart.
const engines = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).engines.vscode;
const minimumVersion = engines.replace(/^[^\d]*/, "");

/**
 * The layout from the "picker shows only one repository" report: a parent folder that is not a
 * repository, repositories one and two levels down, plus decoys that must stay hidden. Rebuilt on
 * every run in the OS temp folder — it must not sit inside this repository, or the folder itself
 * would belong to a repository (gitline's), unlike the reported layout.
 */
function multiRepoFixture() {
  const root = join(tmpdir(), "gitline-multi-repo-fixture");
  rmSync(root, { recursive: true, force: true });
  const repos = [
    "teachers-class-fe",
    "research/json-editor",
    "research/json-viewer",
    "research/text-editor",
    "research/deep/deeper/too-deep", // 4 levels down: beyond the default depth (2)
    "web/node_modules/some-pkg", // inside node_modules: never entered
  ];
  for (const rel of repos) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
  }
  mkdirSync(join(root, "assets"), { recursive: true });
  return root;
}

const common = {
  files: "out-test/test/integration/**/*.test.js",
  mocha: { ui: "bdd", timeout: 60_000 },
};

const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "";

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
  {
    label: "multi-repo",
    version: "stable",
    launchArgs: ["--disable-extensions"],
    // The fixture is only built when this run is the one asked for.
    ...(label === "multi-repo" ? { workspaceFolder: multiRepoFixture(), env: { GITLINE_TEST_MULTI_REPO: "1" } } : {}),
    ...common,
  },
]);
