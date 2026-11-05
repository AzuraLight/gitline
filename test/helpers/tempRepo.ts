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

  head(): string {
    return this.git("rev-parse", "HEAD").trim();
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
