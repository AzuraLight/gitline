import * as path from "path";
import * as vscode from "vscode";
import { tryRootFromBuiltInGit } from "./gitExtensionRoots";
import { getRepoRoot, resolveRepoRootForFile } from "./gitExec";

function pickCwd(uri?: vscode.Uri): string | undefined {
  if (uri && uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }
    return path.dirname(uri.fsPath);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
    return path.dirname(editor.document.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Resolves Git repo root: built-in Git extension, then cwd / folders / editors. */
export async function pickCommitGraphRepoRoot(): Promise<string | null> {
  const fromBuiltIn = await tryRootFromBuiltInGit();
  if (fromBuiltIn) {
    return fromBuiltIn;
  }

  const seen = new Set<string>();
  const tryDir = async (dir: string | undefined): Promise<string | null> => {
    if (!dir) {
      return null;
    }
    const key = path.resolve(dir);
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
    return getRepoRoot(dir);
  };

  const fromCwd = await tryDir(pickCwd());
  if (fromCwd) {
    return fromCwd;
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const r = await tryDir(folder.uri.fsPath);
    if (r) {
      return r;
    }
  }

  if (vscode.window.activeTextEditor?.document.uri.scheme === "file") {
    const fromFile = await resolveRepoRootForFile(vscode.window.activeTextEditor.document.uri.fsPath);
    if (fromFile) {
      return fromFile;
    }
  }

  let n = 0;
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== "file") {
      continue;
    }
    if (n++ > 20) {
      break;
    }
    const r = await resolveRepoRootForFile(doc.uri.fsPath);
    if (r) {
      return r;
    }
  }

  return null;
}
