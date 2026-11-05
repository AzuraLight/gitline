import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import type { GitlineExports } from "../../src/extension";
import { TempRepo } from "../helpers/tempRepo";

const EXTENSION_ID = "AzuraLight.gitline";
const COMMANDS = [
  "gitline.openCommitGraph",
  "gitline.openFileHistory",
  "gitline.pull",
  "gitline.push",
  "gitline.fetchAll",
  "gitline.toggleInlineBlame",
  "gitline.revealCommit",
  "gitline.openCommitPatch",
];

describe("Gitline in VS Code", function () {
  this.timeout(60_000);

  it("activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "extension is installed in the test host");
    await extension.activate();
    assert.ok(extension.isActive);
  });

  it("registers every contributed command", async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const id of COMMANDS) {
      assert.ok(registered.includes(id), `${id} is registered`);
    }
  });

  it("opens the commit graph panel without throwing", async () => {
    await vscode.commands.executeCommand("gitline.openCommitGraph");
  });

  it("keeps inline blame off by default and toggles it", async () => {
    const config = () => vscode.workspace.getConfiguration("gitline.inlineBlame");
    await config().update("enabled", undefined, vscode.ConfigurationTarget.Global); // a crashed run may leave it set
    assert.strictEqual(config().inspect("enabled")?.defaultValue, false);
    assert.strictEqual(config().get("enabled"), false);
    await vscode.commands.executeCommand("gitline.toggleInlineBlame");
    assert.strictEqual(config().get("enabled"), true);
    await vscode.commands.executeCommand("gitline.toggleInlineBlame");
    assert.strictEqual(config().get("enabled"), false);
  });

  it("ignores hover-link commands called without a valid target", async () => {
    await vscode.commands.executeCommand("gitline.revealCommit", { root: "/nope", sha: "not-a-sha" });
    await vscode.commands.executeCommand("gitline.openCommitPatch");
  });

  it("annotates the cursor line, follows unsaved edits, and clears when turned off", async () => {
    const repo = new TempRepo();
    try {
      repo.write("src/Main.java", "class Main {\n  int x;\n}\n");
      repo.commitAll("Add Main class");
      const api = vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
      const config = vscode.workspace.getConfiguration("gitline.inlineBlame");
      await config.update("enabled", true, vscode.ConfigurationTarget.Global);
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, "src/Main.java")));
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      const committed = await waitFor(() => api.inlineBlameText(), (t) => !!t);
      assert.match(committed!, /^Gitline Test, .+ · Add Main class$/);

      await editor.edit((b) => b.insert(new vscode.Position(1, 0), "  // new\n"));
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      assert.strictEqual(await waitFor(() => api.inlineBlameText(), (t) => !!t && t !== committed), "You · Uncommitted changes");

      await config.update("enabled", false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(await waitFor(() => api.inlineBlameText(), (t) => t === undefined), undefined);
    } finally {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      try {
        repo.dispose();
      } catch {
        // VS Code's file watchers can keep the folder locked on Windows; it is in the OS temp dir anyway.
      }
    }
  });
});

/** Polls until `done(read())` holds (decorations update on debounced timers), then returns the value. */
async function waitFor<T>(read: () => T, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (done(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
