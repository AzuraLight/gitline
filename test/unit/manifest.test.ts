import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
  extensionKind?: string[];
  extensionDependencies?: string[];
};

describe("extension manifest (remote development)", () => {
  // Gitline runs `git` on the repository's files, so in a Remote SSH / WSL / container window it
  // must run in the remote extension host, next to the files — as Git Graph and GitLens do.
  it("runs in the workspace (remote) extension host, never only on the UI side", () => {
    assert.ok(manifest.extensionKind?.includes("workspace"), "extensionKind includes workspace");
    assert.ok(!manifest.extensionKind?.includes("ui"), "not a UI extension: it would run away from the files");
  });

  // A hard dependency on vscode.git blocked activation when the Git extension was not loaded in
  // Gitline's host ("depends on the Git extension, which is not loaded"). The Git API is optional:
  // src/gitExtensionRoots.ts falls back to git itself.
  it("does not hard-depend on the built-in Git extension", () => {
    assert.ok(!(manifest.extensionDependencies ?? []).includes("vscode.git"));
  });
});
