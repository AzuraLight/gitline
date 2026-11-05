import * as vscode from "vscode";
import { readBlamePorcelain, repoRelativePath, resolveRepoRootForFile } from "../gitExec";
import { type BlameLine, UNCOMMITTED_SHA, parseBlamePorcelain, relativeTime } from "./parse";

const SETTING_SECTION = "gitline.inlineBlame";
const MAX_SUBJECT = 60;
const LINE_CHANGE_DELAY_MS = 120; // cursor moves faster than anyone reads
const EDIT_DELAY_MS = 600;        // re-blame after typing pauses

type Entry = { version: number; root: string; lines: BlameLine[] } | { version: number; failed: true };

/** What the hover links pass to gitline.revealCommit / gitline.openCommitPatch. */
export type CommitTarget = { root: string; sha: string };

/**
 * Opt-in end-of-line blame for the line under the cursor. One `git blame` per file and
 * document version; cached until the text changes or HEAD / a ref moves.
 */
export class InlineBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 3em", color: new vscode.ThemeColor("editorCodeLens.foreground"), fontStyle: "italic" },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly listeners: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private enabled = false;
  /** Text of the annotation currently shown (undefined when none) — read by the integration tests. */
  lastAnnotation: string | undefined;

  constructor() {
    this.listeners.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTING_SECTION)) this.applySetting();
      }),
    );
    this.applySetting();
  }

  private applySetting(): void {
    const on = vscode.workspace.getConfiguration(SETTING_SECTION).get<boolean>("enabled", false);
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.start();
    else this.stop();
  }

  private start(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.git/{HEAD,refs/**}");
    const clear = () => {
      this.cache.clear();
      this.schedule(0);
    };
    this.listeners.push(
      watcher,
      watcher.onDidChange(clear),
      watcher.onDidCreate(clear),
      watcher.onDidDelete(clear),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule(LINE_CHANGE_DELAY_MS);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.clearDecoration();
          this.schedule(EDIT_DELAY_MS);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.cache.delete(d.uri.toString())),
    );
    this.schedule(0);
  }

  private stop(): void {
    // Keep the configuration listener (index 0); drop everything start() added.
    this.listeners.splice(1).forEach((d) => d.dispose());
    this.cache.clear();
    this.clearDecoration();
  }

  private clearDecoration(): void {
    this.lastAnnotation = undefined;
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.decoration, []);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), delayMs);
  }

  private async render(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!this.enabled || !editor || editor.document.uri.scheme !== "file") {
      this.clearDecoration();
      return;
    }
    const doc = editor.document;
    const entry = await this.blameFor(doc);
    // The user may have moved on while git ran.
    if (editor !== vscode.window.activeTextEditor || doc.version !== entry.version) return;
    const lineNo = editor.selection.active.line;
    const blame = "lines" in entry ? entry.lines[lineNo] : undefined;
    if (!blame) {
      editor.setDecorations(this.decoration, []);
      this.lastAnnotation = undefined;
      return;
    }
    const end = doc.lineAt(lineNo).range.end;
    this.lastAnnotation = annotationText(blame);
    editor.setDecorations(this.decoration, [
      {
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: annotationText(blame) } },
        hoverMessage: "root" in entry ? hoverFor(blame, entry.root) : undefined,
      },
    ]);
  }

  private blameFor(doc: vscode.TextDocument): Promise<Entry> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) return Promise.resolve(cached);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const version = doc.version;
    const job = computeBlame(doc).then(
      ({ root, lines }): Entry => ({ version, root, lines }),
      (): Entry => ({ version, failed: true }), // untracked / outside a repo / binary: show nothing
    );
    const tracked = job.then((entry) => {
      this.pending.delete(key);
      this.cache.set(key, entry);
      return entry;
    });
    this.pending.set(key, tracked);
    return tracked;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.splice(0).forEach((d) => d.dispose());
    this.decoration.dispose();
  }
}

async function computeBlame(doc: vscode.TextDocument): Promise<{ root: string; lines: BlameLine[] }> {
  const root = await resolveRepoRootForFile(doc.uri.fsPath);
  if (!root) throw new Error("not in a repository");
  const rel = repoRelativePath(root, doc.uri.fsPath);
  return { root, lines: parseBlamePorcelain(await readBlamePorcelain(root, rel, doc.getText())) };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function annotationText(b: BlameLine): string {
  if (b.sha === UNCOMMITTED_SHA) return vscode.l10n.t("You · Uncommitted changes");
  return `${b.author}, ${relativeTime(b.authorTime)} · ${truncate(b.summary, MAX_SUBJECT)}`;
}

function commandLink(command: string, arg: CommitTarget): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([arg]))}`;
}

function hoverFor(b: BlameLine, root: string): vscode.MarkdownString | undefined {
  if (b.sha === UNCOMMITTED_SHA) return undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ["gitline.revealCommit", "gitline.openCommitPatch"] };
  md.appendMarkdown(`**${escapeMd(b.summary)}**\n\n`);
  md.appendMarkdown(`$(git-commit) \`${b.sha.slice(0, 7)}\` · ${escapeMd(b.author)} · ${new Date(b.authorTime * 1000).toLocaleString()}\n\n`);
  md.appendMarkdown(
    `[${vscode.l10n.t("Open in Gitline graph")}](${commandLink("gitline.revealCommit", { root, sha: b.sha })})` +
      ` · [${vscode.l10n.t("Open commit patch")}](${commandLink("gitline.openCommitPatch", { root, sha: b.sha })})`,
  );
  return md;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
