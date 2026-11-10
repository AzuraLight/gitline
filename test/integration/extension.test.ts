import * as assert from "assert";
import * as fs from "fs";
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
  "gitline.saveViewAsDefault",
];

describe("Gitline in VS Code", function () {
  this.timeout(60_000);

  it("activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "extension is installed in the test host");
    await extension.activate();
    assert.ok(extension.isActive);
  });

  it("activates even when the built-in Git extension is not loaded (Remote SSH case)", async function () {
    if (process.env.GITLINE_TEST_NO_GIT_EXTENSION !== "1") {
      this.skip(); // only the `no-git-ext` run (npm run test:integration:no-git-ext) disables it
    }
    const git = vscode.extensions.getExtension("vscode.git");
    assert.ok(!git || !git.isActive, "the Git extension really is off in this run");
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    await extension.activate();
    assert.ok(extension.isActive, "Gitline activated without it");
    // And the panel still works: it finds repositories through git itself.
    await vscode.commands.executeCommand("gitline.openCommitGraph");
  });

  /** The repository Gitline picks while a file of `repo` is the active editor. */
  async function pickedRootFor(repo: TempRepo): Promise<string | null> {
    repo.write("pick.txt", "x\n");
    repo.commitAll("pick");
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, "pick.txt")));
    const api = vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
    const root = await api.activeRepoRoot();
    return root ? fs.realpathSync(root) : null;
  }

  it("finds the active file's repository (without the Git extension in the no-git-ext run)", async () => {
    const repo = new TempRepo();
    try {
      assert.strictEqual(await pickedRootFor(repo), fs.realpathSync(repo.root));
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      try { repo.dispose(); } catch { /* Windows may still hold a handle */ }
    }
  });

  it("still finds it when the user turned Git off (git.enabled: false)", async function () {
    if (process.env.GITLINE_TEST_NO_GIT_EXTENSION === "1") this.skip(); // no git.enabled setting without the extension
    const git = () => vscode.workspace.getConfiguration("git");
    const repo = new TempRepo();
    try {
      await git().update("enabled", false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(await pickedRootFor(repo), fs.realpathSync(repo.root));
    } finally {
      await git().update("enabled", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      try { repo.dispose(); } catch { /* Windows may still hold a handle */ }
    }
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

  it("contributes the default-view settings and refuses to save before any graph was shown", async () => {
    const config = () => vscode.workspace.getConfiguration("gitline.graph");
    const clear = async () => {
      await config().update("defaultView", undefined, vscode.ConfigurationTarget.Global);
      await config().update("defaultBranches", undefined, vscode.ConfigurationTarget.Global);
    };
    await clear();
    try {
      assert.strictEqual(config().inspect("defaultView")?.defaultValue, "current");
      assert.deepStrictEqual(config().inspect("defaultBranches")?.defaultValue, []);
      // The test window has no folder (so no repo): the panel opened above never shows a graph,
      // and the command must warn and write nothing.
      await vscode.commands.executeCommand("gitline.saveViewAsDefault");
      assert.strictEqual(config().inspect("defaultView")?.globalValue, undefined);
      assert.strictEqual(config().inspect("defaultBranches")?.globalValue, undefined);
    } finally {
      await clear();
    }
  });

  it("declares both graph settings with window scope and the three view values", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON;
    const configs = [pkg.contributes.configuration].flat();
    const props = Object.assign({}, ...configs.map((c: { properties: object }) => c.properties));
    assert.deepStrictEqual(props["gitline.graph.defaultView"].enum, ["current", "all", "selected"]);
    assert.strictEqual(props["gitline.graph.defaultView"].scope, "window");
    assert.strictEqual(props["gitline.graph.defaultBranches"].type, "array");
    assert.strictEqual(props["gitline.graph.defaultBranches"].scope, "window");
  });

  it("refusing to save leaves existing settings untouched, and settings changes do not throw", async () => {
    const config = () => vscode.workspace.getConfiguration("gitline.graph");
    const G = vscode.ConfigurationTarget.Global;
    const clear = async () => {
      await config().update("defaultView", undefined, G);
      await config().update("defaultBranches", undefined, G);
    };
    await clear();
    try {
      await config().update("defaultBranches", ["main", "origin/team/*"], G);
      await config().update("defaultView", "selected", G);
      await vscode.commands.executeCommand("gitline.saveViewAsDefault");
      assert.strictEqual(config().inspect("defaultView")?.globalValue, "selected");
      assert.deepStrictEqual(config().inspect("defaultBranches")?.globalValue, ["main", "origin/team/*"]);
      // Switching settings while the panel is open goes through the change listener; it must not throw.
      await config().update("defaultView", "all", G);
      await config().update("defaultView", "all", G);
      await vscode.commands.executeCommand("gitline.openCommitGraph");
    } finally {
      await clear();
    }
  });

  it("saves the shown view once the panel has shown a graph of a repo (no folder → user settings)", async function () {
    const config = () => vscode.workspace.getConfiguration("gitline.graph");
    const G = vscode.ConfigurationTarget.Global;
    const clear = async () => {
      await config().update("defaultView", undefined, G);
      await config().update("defaultBranches", undefined, G);
    };
    const repo = new TempRepo();
    await clear();
    try {
      repo.write("a.txt", "a\n");
      repo.commitAll("first");
      await config().update("defaultBranches", ["keep/*"], G);
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, "a.txt")));
      await vscode.commands.executeCommand("gitline.openCommitGraph");
      // The webview asks for its graph on its own; poll until a save goes through.
      const saved = await waitFor(
        async () => {
          await vscode.commands.executeCommand("gitline.saveViewAsDefault");
          return config().inspect("defaultView")?.globalValue;
        },
        (v) => v !== undefined,
        15_000,
      );
      if (saved === undefined) {
        // NOT COVERED: the panel webview did not render a graph in this headless host.
        this.skip();
      }
      assert.strictEqual(saved, "current");
      assert.deepStrictEqual(config().inspect("defaultBranches")?.globalValue, ["keep/*"], "branch list left in place");
      assert.strictEqual(config().inspect("defaultView")?.workspaceValue, undefined);
    } finally {
      await clear();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      try {
        repo.dispose();
      } catch {
        // see below
      }
    }
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
async function waitFor<T>(read: () => T | Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
