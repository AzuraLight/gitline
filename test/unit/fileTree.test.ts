import * as assert from "assert";
import * as path from "path";

type FileNode = { type: "file"; name: string; file: { path: string } };
type FolderNode = { type: "folder"; name: string; path: string; count: number; children: TreeNode[] };
type TreeNode = FileNode | FolderNode;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildFileTree } = require(path.resolve(__dirname, "../../../media/webview/fileTree.js")) as {
  buildFileTree: (files: { path: string }[]) => TreeNode[];
};

/** "name(count)" for folders, "name" for files, children indented — easy to read in a failure diff. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return nodes.flatMap((n) =>
    n.type === "folder" ? [`${pad}${n.name}(${n.count})`, ...outline(n.children, depth + 1)] : [`${pad}${n.name}`],
  );
}

describe("buildFileTree", () => {
  it("compacts single-child folder chains and counts files per folder", () => {
    const tree = buildFileTree([
      { path: "src/main/java/com/example/App.java" },
      { path: "src/main/java/com/example/util/Strings.java" },
      { path: "src/main/java/com/example/util/Dates.java" },
      { path: "README.md" },
    ]);
    assert.deepStrictEqual(outline(tree), [
      "src/main/java/com/example(3)",
      "  util(2)",
      "    Dates.java",
      "    Strings.java",
      "  App.java",
      "README.md",
    ]);
  });

  it("keeps the full folder path on compacted nodes", () => {
    const [folder] = buildFileTree([{ path: "a/b/c/x.txt" }, { path: "a/b/c/y.txt" }]) as FolderNode[];
    assert.strictEqual(folder.name, "a/b/c");
    assert.strictEqual(folder.path, "a/b/c");
  });

  it("does not merge a folder that also holds files", () => {
    assert.deepStrictEqual(outline(buildFileTree([{ path: "a/one.txt" }, { path: "a/b/two.txt" }])), [
      "a(2)",
      "  b(1)",
      "    two.txt",
      "  one.txt",
    ]);
  });

  it("handles non-ASCII names and an empty list", () => {
    assert.deepStrictEqual(outline(buildFileTree([{ path: "문서/한글파일.txt" }])), ["문서(1)", "  한글파일.txt"]);
    assert.deepStrictEqual(buildFileTree([]), []);
  });
});
