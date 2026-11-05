/** One line's blame. `sha` is all zeros for lines that are not committed yet. */
export type BlameLine = {
  sha: string;
  author: string;
  authorMail: string;
  authorTime: number; // unix seconds
  summary: string;
};

export const UNCOMMITTED_SHA = "0".repeat(40);

const HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * Parses `git blame --porcelain` into one entry per final line (index 0 = line 1).
 * Porcelain prints a commit's details only the first time it appears, so they are remembered by sha.
 */
export function parseBlamePorcelain(out: string): BlameLine[] {
  const commits = new Map<string, BlameLine>();
  const lines: BlameLine[] = [];
  let current: BlameLine | null = null;
  let finalLine = 0;
  for (const row of out.split("\n")) {
    const header = HEADER.exec(row);
    if (header) {
      const sha = header[1];
      finalLine = Number(header[2]);
      current = commits.get(sha) ?? { sha, author: "", authorMail: "", authorTime: 0, summary: "" };
      commits.set(sha, current);
      continue;
    }
    if (!current) continue;
    if (row.startsWith("\t")) {
      lines[finalLine - 1] = current; // the content row ends this line's record
    } else if (row.startsWith("author ")) {
      current.author = row.slice(7);
    } else if (row.startsWith("author-mail ")) {
      current.authorMail = row.slice(12).replace(/^<|>$/g, "");
    } else if (row.startsWith("author-time ")) {
      current.authorTime = Number(row.slice(12));
    } else if (row.startsWith("summary ")) {
      current.summary = row.slice(8);
    }
  }
  return lines;
}

const UNITS: Array<[number, string]> = [
  [365 * 86400, "year"],
  [30 * 86400, "month"],
  [7 * 86400, "week"],
  [86400, "day"],
  [3600, "hour"],
  [60, "minute"],
];

/** "3 weeks ago", "just now" — English; the caller localizes the surrounding text. */
export function relativeTime(sec: number, nowSec: number = Date.now() / 1000): string {
  const diff = Math.max(0, Math.floor(nowSec - sec));
  for (const [size, unit] of UNITS) {
    if (diff >= size) {
      const n = Math.floor(diff / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
