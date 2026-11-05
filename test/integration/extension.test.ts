import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "AzuraLight.gitline";
const COMMANDS = [
  "gitline.openCommitGraph",
  "gitline.openFileHistory",
  "gitline.pull",
  "gitline.push",
  "gitline.fetchAll",
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
});
