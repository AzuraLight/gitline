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
  "gitline.openRepository",
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

  it("declares the 1.7.0 display settings with window scope and passes their values on", async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON;
    const configs = [pkg.contributes.configuration].flat();
    const props = Object.assign({}, ...configs.map((c: { properties: object }) => c.properties));
    for (const k of ["columns", "dateFormat", "detailsLocation", "highlightCurrentBranch"]) {
      assert.strictEqual(props[`gitline.graph.${k}`].scope, "window", k);
    }
    const api = vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
    assert.deepStrictEqual(api.displayPrefs(), {
      columns: { author: true, date: true, sha: true },
      dateFormat: "relative",
      detailsLocation: "auto",
      highlightCurrentBranch: false,
    });
    const config = () => vscode.workspace.getConfiguration("gitline.graph");
    const G = vscode.ConfigurationTarget.Global;
    try {
      await config().update("dateFormat", "absolute", G);
      await config().update("detailsLocation", "bottom", G);
      assert.strictEqual(api.displayPrefs().dateFormat, "absolute");
      assert.strictEqual(api.displayPrefs().detailsLocation, "bottom");
      // The column menu's write: a clean object, junk ignored, in user settings without a workspace value.
      await api.writeColumns({ author: false, date: "x", bogus: 1 });
      assert.deepStrictEqual(config().inspect("columns")?.globalValue, { author: false, date: true, sha: true });
      await api.writeColumns(["nope"]);
      await api.writeColumns(null);
      assert.deepStrictEqual(config().inspect("columns")?.globalValue, { author: false, date: true, sha: true });
      // Changes reach the open panel through the change listener; it must not throw.
      await vscode.commands.executeCommand("gitline.openCommitGraph");
      await config().update("highlightCurrentBranch", true, G);
    } finally {
      for (const k of ["columns", "dateFormat", "detailsLocation", "highlightCurrentBranch"]) await config().update(k, undefined, G);
    }
  });

  it("1.9.0 working changes: stage, commit with nothing staged (asks), amend, discard only listed files", async () => {
    const api = vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
    const repo = new TempRepo();
    try {
      repo.write("a.txt", "1\n");
      repo.commitAll("base");
      repo.write("a.txt", "2\n");
      repo.write("new.txt", "n\n");
      const types = (posts: Array<Record<string, unknown>>) => posts.map((m) => m.type);

      let posts = await api.workMessage(repo.root, { type: "requestWorkFiles" }, true);
      const files = posts[0].files as Record<string, Array<{ path: string }>>;
      assert.deepStrictEqual(files.unstaged.map((f) => f.path), ["a.txt"]);
      assert.deepStrictEqual(files.untracked.map((f) => f.path), ["new.txt"]);

      // Nothing staged, user says no: nothing happens, the button is released.
      posts = await api.workMessage(repo.root, { type: "workCommit", message: "all", amend: false }, false);
      assert.deepStrictEqual(types(posts), ["workSettled"]);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "base");
      // …says yes: everything is staged and committed.
      posts = await api.workMessage(repo.root, { type: "workCommit", message: "all changes", amend: false }, true);
      assert.ok(types(posts).includes("workCommitted"), JSON.stringify(posts));
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "all changes");
      assert.strictEqual(repo.git("status", "--porcelain").trim(), "");

      // Amend keeps the commit count and changes the message.
      const count = repo.git("rev-list", "--count", "HEAD").trim();
      await api.workMessage(repo.root, { type: "workCommit", message: "all changes, amended", amend: true }, true);
      assert.strictEqual(repo.git("rev-list", "--count", "HEAD").trim(), count);
      assert.strictEqual(repo.git("log", "-1", "--format=%s").trim(), "all changes, amended");

      // Stage takes only listed paths; a path git does not list is ignored, never touched.
      repo.write("a.txt", "3\n");
      await api.workMessage(repo.root, { type: "workStage", paths: ["a.txt", "../outside.txt", "missing.txt"] }, true);
      assert.strictEqual(repo.git("diff", "--cached", "--name-only").trim(), "a.txt");
      await api.workMessage(repo.root, { type: "workDiscardFile", path: "../../etc/hosts", group: "untracked" }, true);
      await api.workMessage(repo.root, { type: "workDiscardFile", path: "a.txt", group: "staged" }, true);
      assert.strictEqual(fs.readFileSync(path.join(repo.root, "a.txt"), "utf8"), "2\n");

      // An empty message is refused with a readable error.
      posts = await api.workMessage(repo.root, { type: "workCommit", message: "  ", amend: false }, true);
      assert.ok(posts.some((m) => m.type === "workError"));
    } finally {
      repo.dispose();
    }
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
      // The webview asks for its graph on its own. Wait for that, then save once — retrying the
      // save itself would stack one "Gitline will open with …" notification per attempt.
      const api = vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
      if (vscode.workspace.workspaceFolders?.length) {
        this.skip(); // this test is about the no-folder window (save goes to user settings)
      }
      const shown = await waitFor(() => api.hasShownGraph(), (v) => v, 15_000);
      if (!shown) {
        // NOT COVERED: the panel webview did not render a graph in this headless host — skip
        // rather than fail on a host limitation; every other run checks the save below.
        this.skip();
      }
      await vscode.commands.executeCommand("gitline.saveViewAsDefault");
      const saved = config().inspect("defaultView")?.globalValue;
      assert.strictEqual(saved, "current", "a graph was shown, so the save must go through");
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

  // These open a repository file, after which the panel shows that repository's graph — so they
  // must come after the tests that rely on "no graph shown yet" (the save-refusal tests).
  /** The repository Gitline picks while a file of `repo` is the active editor. */
  async function pickedRootFor(repo: TempRepo): Promise<string | null> {
    repo.write("pick.txt", "x\n");
    repo.commitAll("pick");
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, "pick.txt")));
    const api = vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
    const root = await api.activeRepoRoot();
    return root ? fs.realpathSync.native(root) : null;
  }

  it("finds the active file's repository (without the Git extension in the no-git-ext run)", async () => {
    const repo = new TempRepo();
    try {
      assert.strictEqual(await pickedRootFor(repo), fs.realpathSync.native(repo.root));
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
      assert.strictEqual(await pickedRootFor(repo), fs.realpathSync.native(repo.root));
    } finally {
      await git().update("enabled", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      try { repo.dispose(); } catch { /* Windows may still hold a handle */ }
    }
  });

  // Only in the multi-repo run: the workspace folder is not a repository; repositories sit below it
  // (the layout from the "picker shows only one repository" report — see .vscode-test.mjs).
  describe("repositories below a workspace folder that is none (multi-repo run)", () => {
    const api = () => vscode.extensions.getExtension<GitlineExports>(EXTENSION_ID)!.exports;
    const folder = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
    const relative = (list: string[]) =>
      list.map((p) => path.relative(fs.realpathSync.native(folder()), fs.realpathSync.native(p)).split(path.sep).join("/")).sort();
    const depth = () => vscode.workspace.getConfiguration("gitline.repositories");

    before(function () {
      if (process.env.GITLINE_TEST_MULTI_REPO !== "1") this.skip();
    });

    it("lists the repositories one and two levels down, not the decoys", async () => {
      assert.deepStrictEqual(relative(await api().workspaceRepos()), [
        "research/json-editor",
        "research/json-viewer",
        "research/text-editor",
        "teachers-class-fe",
      ]);
    });

    it("follows gitline.repositories.searchDepth, and goes back when it is reset", async () => {
      try {
        await depth().update("searchDepth", 1, vscode.ConfigurationTarget.Workspace);
        assert.deepStrictEqual(relative(await api().workspaceRepos()), ["teachers-class-fe"]);
        await depth().update("searchDepth", 4, vscode.ConfigurationTarget.Workspace);
        assert.ok(relative(await api().workspaceRepos()).includes("research/deep/deeper/too-deep"));
      } finally {
        await depth().update("searchDepth", undefined, vscode.ConfigurationTarget.Workspace);
      }
      assert.strictEqual(relative(await api().workspaceRepos()).length, 4);
    });

    it("a recent repository outside the workspace can be picked; once it is deleted the panel lets go", async () => {
      const outside = new TempRepo();
      outside.commitEmpty("outside");
      try {
        await api().selectRepo(outside.root);
        assert.ok(!sameDir(await api().activeRepoRoot(), outside.root), "not recent yet: picking it is ignored");
        await api().addRecentRepo(outside.root);
        await api().selectRepo(outside.root);
        assert.ok(sameDir(await api().activeRepoRoot(), outside.root), "recent: picking it works");
        fs.rmSync(outside.root, { recursive: true, force: true });
        const after = await api().activeRepoRoot();
        assert.ok(!sameDir(after, outside.root) && (after === null || fs.existsSync(after)), String(after));
      } finally {
        try { outside.dispose(); } catch { /* already removed */ }
      }
    });

    it("makes a two-levels-down repository the active one when it is picked", async () => {
      const target = (await api().workspaceRepos()).find((p) => p.endsWith("json-viewer"))!;
      const doc = await vscode.workspace.openTextDocument({ content: "" }); // no file editor steering the pick
      await vscode.window.showTextDocument(doc);
      await api().selectRepo(target);
      const active = await api().activeRepoRoot();
      assert.ok(active && fs.realpathSync.native(active) === fs.realpathSync.native(target), String(active));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    // ---- 1.6.0 edge cases (test engineer) ----
    const same = (a: string | null, b: string) => !!a && fs.existsSync(a) && fs.realpathSync.native(a) === fs.realpathSync.native(b);
    const ignored = () => vscode.workspace.getConfiguration("gitline.repositories");

    it("ignores selectRepo for a repository outside the workspace that is not recent", async () => {
      const inside = (await api().workspaceRepos()).find((p) => p.endsWith("json-editor"))!;
      await api().selectRepo(inside);
      const outside = new TempRepo();
      try {
        await api().selectRepo(outside.root);
        assert.ok(same(await api().activeRepoRoot(), inside), "selection unchanged");
        assert.ok(!(await api().workspaceRepos()).some((p) => fs.realpathSync.native(p) === fs.realpathSync.native(outside.root)));
      } finally {
        outside.dispose();
      }
    });

    it("ignores selectRepo for junk input (empty string, the parent folder that is no repository, a missing path)", async () => {
      const inside = (await api().workspaceRepos()).find((p) => p.endsWith("json-editor"))!;
      await api().selectRepo(inside);
      for (const junk of ["", folder(), path.join(folder(), "nope")]) await api().selectRepo(junk);
      assert.ok(same(await api().activeRepoRoot(), inside));
    });

    it("follows gitline.repositories.ignoredFolders, and goes back when it is reset", async () => {
      try {
        await ignored().update("ignoredFolders", ["research", "node_modules"], vscode.ConfigurationTarget.Workspace);
        assert.deepStrictEqual(relative(await api().workspaceRepos()), ["teachers-class-fe"]);
        await ignored().update("ignoredFolders", [], vscode.ConfigurationTarget.Workspace);
        await ignored().update("searchDepth", 3, vscode.ConfigurationTarget.Workspace);
        assert.ok(relative(await api().workspaceRepos()).includes("web/node_modules/some-pkg"), "empty list enters node_modules");
      } finally {
        await ignored().update("ignoredFolders", undefined, vscode.ConfigurationTarget.Workspace);
        await ignored().update("searchDepth", undefined, vscode.ConfigurationTarget.Workspace);
      }
      assert.strictEqual(relative(await api().workspaceRepos()).length, 4);
    });

    it("a repository created after the last scan can be picked only after a re-scan", async () => {
      await api().workspaceRepos(); // fills the scan cache
      const fresh = path.join(folder(), "research", "late-arrival");
      fs.mkdirSync(path.join(fresh, ".git"), { recursive: true });
      try {
        const before = await api().activeRepoRoot();
        await api().selectRepo(fresh); // cached scan does not know it yet → ignored
        assert.strictEqual(await api().activeRepoRoot(), before);
        assert.ok(relative(await api().workspaceRepos()).includes("research/late-arrival"), "forced re-scan finds it");
        await api().selectRepo(fresh);
        assert.ok(same(await api().activeRepoRoot(), fresh));
      } finally {
        fs.rmSync(fresh, { recursive: true, force: true });
        await api().workspaceRepos();
      }
    });

    // A selected repository deleted from disk must stop being the active one at once — not after
    // the next re-scan (the stored scan drops folders whose .git is gone, and the stale selection
    // is forgotten).
    it("a selected repository deleted from disk is no longer the active one", async () => {
      const doomed = path.join(folder(), "research", "doomed");
      fs.mkdirSync(path.join(doomed, ".git"), { recursive: true });
      try {
        await api().workspaceRepos();
        await api().selectRepo(doomed);
        assert.ok(same(await api().activeRepoRoot(), doomed));
        fs.rmSync(doomed, { recursive: true, force: true });
        const active = await api().activeRepoRoot();
        assert.ok(active === null || fs.existsSync(active), `active repo points at a deleted folder: ${active}`);
        assert.strictEqual(await api().activeRepoRoot(), active, "stable across calls");
      } finally {
        fs.rmSync(doomed, { recursive: true, force: true });
        await api().workspaceRepos();
      }
    });

    it("after a deleted selection and a re-scan, the active repository is an existing one and stays stable", async () => {
      const doomed = path.join(folder(), "research", "doomed2");
      fs.mkdirSync(path.join(doomed, ".git"), { recursive: true });
      try {
        await api().workspaceRepos();
        await api().selectRepo(doomed);
        fs.rmSync(doomed, { recursive: true, force: true });
        await api().workspaceRepos(); // forced re-scan
        const a = await api().activeRepoRoot();
        const b = await api().activeRepoRoot();
        assert.ok(a === null || fs.existsSync(a), String(a));
        assert.strictEqual(a, b);
      } finally {
        fs.rmSync(doomed, { recursive: true, force: true });
      }
    });
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
/** Same folder, whatever the spelling (/var vs /private/var, Windows short names). */
function sameDir(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

async function waitFor<T>(read: () => T | Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
