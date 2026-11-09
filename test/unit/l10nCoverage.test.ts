// Every user-visible string has a translation entry: vscode.l10n.t(...) in src → l10n bundles,
// %key% in package.json → package.nls*.json.
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const readJson = (rel: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? srcFiles(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}

function l10nStrings(): { key: string; where: string }[] {
  const out: { key: string; where: string }[] = [];
  for (const file of srcFiles(path.join(ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/l10n\.t\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)/g)) {
      const lit = m[1];
      const key = lit.startsWith('"') ? JSON.parse(lit) : lit.slice(1, -1).replace(/\\'/g, "'");
      out.push({ key, where: path.relative(ROOT, file) });
    }
  }
  return out;
}

describe("l10n coverage", () => {
  it("finds the l10n calls at all", () => {
    assert.ok(l10nStrings().length > 20);
    assert.ok(l10nStrings().some((s) => s.key.startsWith("Open the Gitline panel and pick a view first")));
  });

  const NEW_IN_150 = [
    "{0} branches",
    "Ctrl/Cmd+click to add to the view",
    "No branch matches {0} in this repository — showing the default history instead.",
    "Open the Gitline panel and pick a view first, then save it as the default.",
    "Saved, but another gitline.graph setting overrides it. Check your workspace settings.",
    "workspace settings",
    "user settings",
    "the current branch",
    "all branches",
    "Gitline will open with {0} ({1}).",
  ];
  for (const bundle of ["l10n/bundle.l10n.json", "l10n/bundle.l10n.ko.json"]) {
    it(`has the 1.5.0 strings in ${bundle}`, () => {
      const used = new Set(l10nStrings().map((s) => s.key));
      for (const k of NEW_IN_150) assert.ok(used.has(k), `still used in src: ${k}`);
      const entries = readJson(bundle);
      assert.deepStrictEqual(NEW_IN_150.filter((k) => !(k in entries)), []);
    });
  }

  // A string missing here is shown untranslated (32 rebase / compare / merges strings were, from
  // 1.0.1 until 1.5.0 filled them in).
  for (const bundle of ["l10n/bundle.l10n.json", "l10n/bundle.l10n.ko.json"]) {
    it(`has every vscode.l10n.t string in ${bundle}`, () => {
      const entries = readJson(bundle);
      const missing = l10nStrings().filter((s) => !(s.key in entries)).map((s) => `${s.where}: ${JSON.stringify(s.key)}`);
      assert.deepStrictEqual([...new Set(missing)], []);
    });
  }

  it("keeps the {n} placeholders of each Korean translation", () => {
    const ko = readJson("l10n/bundle.l10n.ko.json");
    const bad = Object.entries(ko).filter(([k, v]) => {
      const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
      return typeof v !== "string" || ph(k) !== ph(v);
    });
    assert.deepStrictEqual(bad, []);
  });

  for (const nls of ["package.nls.json", "package.nls.ko.json"]) {
    it(`has every %key% of package.json in ${nls}`, () => {
      const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
      const keys = [...new Set([...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]))];
      assert.ok(keys.includes("config.graph.defaultView") && keys.includes("command.saveViewAsDefault.title"));
      const entries = readJson(nls);
      assert.deepStrictEqual(keys.filter((k) => !(k in entries)), []);
    });
  }
});
