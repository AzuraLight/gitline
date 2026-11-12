import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** A throwaway git repository for one test — created in the OS temp folder, removed by `dispose()`. */
export class TempRepo {
  readonly root: string;

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "gitline-test-"));
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "user.name", "Gitline Test");
    this.git("config", "commit.gpgsign", "false");
    // Windows runners default to autocrlf=true and a 260-character path limit: tests compare
    // bytes git writes back and use very long paths.
    this.git("config", "core.autocrlf", "false");
    this.git("config", "core.longpaths", "true");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" });
  }

  write(relativePath: string, content: string): void {
    const full = path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }

  append(relativePath: string, content: string): void {
    fs.appendFileSync(path.join(this.root, relativePath), content, "utf8");
  }

  /** Stages everything and commits; returns the new commit's full hash. */
  commitAll(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.head();
  }

  commitEmpty(message: string): string {
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.head();
  }

  /**
   * Appends `count` empty commits named `${prefix}1`…`${prefix}N` on the current branch with a single
   * `git fast-import` process — spawning git per commit takes minutes on Windows CI runners.
   */
  commitEmptyMany(count: number, prefix: string): void {
    const branch = this.git("symbolic-ref", "HEAD").trim();
    const parent = this.head();
    const stream: string[] = [];
    for (let i = 1; i <= count; i++) {
      const msg = `${prefix}${i}`;
      const when = `${1_700_000_000 + i} +0000`;
      stream.push(
        `commit ${branch}`,
        `committer Gitline Test <test@example.com> ${when}`,
        `data ${Buffer.byteLength(msg)}`,
        msg,
      );
      if (i === 1) stream.push(`from ${parent}`);
      stream.push("");
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: this.root, input: stream.join("\n") + "\n" });
    this.git("reset", "-q", "--hard", branch);
  }

  head(): string {
    return this.git("rev-parse", "HEAD").trim();
  }

  /** Windows refuses to delete files another process still has open, so retry briefly. */
  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
