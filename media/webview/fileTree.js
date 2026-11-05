// Pure: turns a flat changed-files list into a folder tree. No DOM — also loaded by the unit tests.
(function (factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (window.GV = window.GV || {}).fileTree = api;
})(function () {
  "use strict";

  function newFolder(name, path) {
    return { type: "folder", name: name, path: path, count: 0, folders: {}, children: [] };
  }

  function byName(a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }

  /** Inserts each file under its folder chain and counts files per folder. */
  function insertAll(root, files) {
    files.forEach(function (f) {
      var parts = String(f.path).split("/");
      var fileName = parts.pop();
      var node = root;
      node.count++;
      parts.forEach(function (part) {
        if (!node.folders[part]) node.folders[part] = newFolder(part, node.path ? node.path + "/" + part : part);
        node = node.folders[part];
        node.count++;
      });
      node.children.push({ type: "file", name: fileName, file: f });
    });
  }

  /**
   * Folders first, then files, each sorted by name. A folder whose only child is one folder
   * merges with it ("src" + "main" → "src/main"), like VS Code's compact folders.
   */
  function finish(folder) {
    var subfolders = Object.keys(folder.folders).map(function (k) { return finish(folder.folders[k]); }).sort(byName);
    var files = folder.children.sort(byName);
    delete folder.folders;
    folder.children = subfolders.concat(files);
    if (folder.name && folder.children.length === 1 && folder.children[0].type === "folder") {
      var only = folder.children[0];
      return { type: "folder", name: folder.name + "/" + only.name, path: only.path, count: only.count, children: only.children };
    }
    return folder;
  }

  /** files: [{ path, … }] → top-level nodes. Folder: { type, name, path, count, children }. File: { type, name, file }. */
  function buildFileTree(files) {
    var root = newFolder("", "");
    insertAll(root, files || []);
    return finish(root).children;
  }

  return { buildFileTree: buildFileTree };
});
