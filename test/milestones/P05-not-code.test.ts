// P05: `solve` improves a JSON configuration (parameter tuning), a Markdown document scored by a script, and a CSV
// data file cleaned to raise a quality score.
// How it decides: each artifact is the only file Synthe may change in a temp git repo, with an exact score script.
// Scripted proposers decide only from their stdin. The JSON tuner steps each parameter up or down from its current
// kept value and never repeats a summary from the history. The Markdown and CSV proposers first offer a change that
// lowers the score, then the real fixes. The check passes when result.json gives the exact baseline and final scores,
// the change that lowers the score is refused, and the branch holds the improved file.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { approx, fileOnBranch, keptAttempts, makeRepo, pick, problemFile, rng, solve, word, workDir, write, writeMenuProposer, type Proposal } from "./helpers-b.ts";

const seed = () => `${process.pid}-${Date.now()}`;

test("solve tunes the parameters in a JSON configuration", async () => {
  const r = rng(`P05-json-${seed()}`);
  const work = workDir("p05-json");
  const ttlTarget = pick(r, [300, 600]);
  const maxTarget = pick(r, [125, 200]);
  const service = word(r);
  const score = (ttl: number, max: number) => 100 - Math.abs(ttl - ttlTarget) / 10 - Math.abs(max - maxTarget) / 5;
  const repo = makeRepo(join(work, "repo"), {
    "config/cache.json": `${JSON.stringify({ service, ttl_seconds: 900, max_entries: 50, eviction: "lru" }, null, 2)}\n`,
    "measure/score.js": `const c = JSON.parse(require("fs").readFileSync("config/cache.json", "utf8"));\nconst s = 100 - Math.abs(c.ttl_seconds - ${ttlTarget}) / 10 - Math.abs(c.max_entries - ${maxTarget}) / 5;\nconsole.log("simulated 1000 requests");\nconsole.log("hit score " + s);\n`,
  });
  // A tuner that knows nothing of the score: from each parameter's current value it tries one step down, then one
  // step up, and skips every value whose summary is already in the history.
  write(work, "tune.mjs", `let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  const file = input.files.find((f) => f.path === "config/cache.json");
  const cfg = JSON.parse(file.text);
  const tried = new Set(input.history.map((h) => h.summary));
  for (const [key, step] of [["ttl_seconds", 300], ["max_entries", 75]]) {
    for (const v of [cfg[key] - step, cfg[key] + step]) {
      const summary = "set " + key + " to " + v;
      if (v <= 0 || tried.has(summary)) continue;
      const search = '"' + key + '": ' + cfg[key];
      process.stdout.write(JSON.stringify({ proposals: [{ summary, edits: [{ path: "config/cache.json", search, replace: '"' + key + '": ' + v }] }] }));
      return;
    }
  }
  process.stdout.write(JSON.stringify({ proposals: [] }));
});
`);
  const file = problemFile(repo.dir, "tune.problem.json", {
    name: `cache-${service}`, goal: "Raise the cache hit score by tuning the cache settings.",
    artifact: ["config/cache.json"], protect: ["measure/**"],
    measure: { command: "node measure/score.js", direction: "higher", unit: "points", runs: 1 },
    proposer: { command: `node ${JSON.stringify(join(work, "tune.mjs"))}` },
    budget: { max_rounds: 12 },
  });
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");

  const { result } = await solve(file, join(work, "out"));
  approx(result.baseline, score(900, 50), "result.json baseline");
  approx(result.final, 100, "result.json final");
  const cfg = JSON.parse(fileOnBranch(repo, result, "config/cache.json")) as Record<string, unknown>;
  assert.deepEqual(cfg, { service, ttl_seconds: ttlTarget, max_entries: maxTarget, eviction: "lru" }, "the branch holds the tuned configuration, still valid JSON");
  assert.ok(result.attempts.some((a) => a.kept === false), "a step past the best value is refused");
  for (const a of keptAttempts(result)) assert.ok(typeof a.before === "number" && typeof a.after === "number" && a.after > a.before, `a kept attempt raised the score: ${JSON.stringify(a)}`);
});

test("solve improves a Markdown document that a script scores", async () => {
  const r = rng(`P05-md-${seed()}`);
  const work = workDir("p05-md");
  const tool = `${word(r)}-${word(r)}`;
  const intro = `${tool} copies files from one folder to another and keeps a log of each copy.`;
  const long = `You can run ${tool} on any folder, and it will look at every file, compare it with the copy in the other folder, and copy only the files that changed since the last run.`;
  const doc = `# ${tool}\n\n${intro}\n\n${long}\n\n## Usage\n\nRun \`${tool} SOURCE TARGET\`.\n`;
  // +20 for each required section, +20 for an introduction under the title, -10 for each line over 100 characters.
  const scorer = `const t = require("fs").readFileSync("docs/README.md", "utf8");
const lines = t.split("\\n");
let s = 10;
for (const h of ["## Install", "## Usage", "## Configuration"]) if (lines.includes(h)) s += 20;
if (lines[0].startsWith("# ") && lines[1] === "" && lines[2] && !lines[2].startsWith("#")) s += 20;
s -= 10 * lines.filter((l) => l.length > 100).length;
console.log("doc score " + s);
`;
  const repo = makeRepo(join(work, "repo"), { "docs/README.md": doc, "measure/doc.js": scorer });
  const menu: Proposal[] = [
    { summary: "drop the opening paragraphs", edits: [{ path: "docs/README.md", search: `${intro}\n\n${long}\n\n`, replace: "" }] },
    { summary: "add an Install section", edits: [{ path: "docs/README.md", search: "## Usage\n", replace: `## Install\n\nRun \`npm install -g ${tool}\`.\n\n## Usage\n` }] },
    { summary: "split the long line", edits: [{ path: "docs/README.md", search: long, replace: long.replace(", and it will look", ".\nIt looks").replace(", compare it", ", compares it").replace(", and copy only", ",\nand copies only") }] },
    { summary: "add a Configuration section", edits: [{ path: "docs/README.md", search: `Run \`${tool} SOURCE TARGET\`.\n`, replace: `Run \`${tool} SOURCE TARGET\`.\n\n## Configuration\n\nSet \`LOG_FILE\` to choose where the log goes.\n` }] },
  ];
  write(work, "menu.json", JSON.stringify(menu));
  const proposer = writeMenuProposer(join(work, "propose.mjs"), join(work, "menu.json"), join(work, "proposer.log"), true);
  const file = problemFile(repo.dir, "doc.problem.json", {
    name: `doc-${word(r)}`, goal: "Make the README complete and easy to read.",
    artifact: ["docs/*.md"], protect: ["measure/**"],
    measure: { command: "node measure/doc.js", direction: "higher", unit: "points", runs: 1 },
    proposer: { command: `node ${JSON.stringify(proposer)}` },
    budget: { max_rounds: 8 },
  });
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");

  const { result } = await solve(file, join(work, "out"));
  approx(result.baseline, 40, "result.json baseline");
  approx(result.final, 90, "result.json final");
  assert.deepEqual(keptAttempts(result).map((a) => a.summary).sort(), menu.slice(1).map((m) => m.summary).sort(), "the three real fixes are kept");
  assert.equal(result.attempts.find((a) => a.summary === menu[0].summary)?.kept, false, "dropping the opening paragraphs is refused");
  const kept = fileOnBranch(repo, result, "docs/README.md");
  for (const part of [intro, "## Install", "## Usage", "## Configuration"]) assert.ok(kept.includes(part), `the branch's README has "${part}"`);
  assert.ok(kept.split("\n").every((l) => l.length <= 100), "no line on the branch is over 100 characters");
});

test("solve cleans a CSV data file to raise its quality score", async () => {
  const r = rng(`P05-csv-${seed()}`);
  const work = workDir("p05-csv");
  const names = [word(r), "Old Mill", "North Gate", "Ridge", "Bay"].map((n, i) => (i === 0 ? n[0].toUpperCase() + n.slice(1) : n));
  const rows = [
    "id,name,lat,lon",
    `1,${names[0]},51.50,-0.12`,
    `2, ${names[1]} ,48.85,2.35`,
    `3,${names[2]},52.52,13.40`,
    `3,${names[2]},52.52,13.40`,
    `4,${names[3]},140.0,7.0`,
    `5,${names[4]};45.46;9.19`,
  ];
  const csv = `${rows.join("\n")}\n`;
  // 100 + 10 for each valid row with a new id, -10 for each other row, -20 for each expected id that is missing.
  const scorer = `const lines = require("fs").readFileSync("data/stations.csv", "utf8").trim().split("\\n").slice(1);
const seen = new Set();
let s = 100;
for (const l of lines) {
  const [id, name, lat, lon, extra] = l.split(",");
  const ok = /^\\d+$/.test(id) && name && name === name.trim() && extra === undefined && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180 && lat !== "" && lon !== undefined && !seen.has(id);
  if (/^\\d+$/.test(id)) seen.add(id);
  s += ok ? 10 : -10;
}
for (const id of ["1", "2", "3", "4", "5"]) if (!seen.has(id)) s -= 20;
console.log("rows: " + lines.length);
console.log("quality " + s);
`;
  const repo = makeRepo(join(work, "repo"), { "data/stations.csv": csv, "measure/quality.js": scorer });
  const menu: Proposal[] = [
    { summary: "drop the rows that fail validation", edits: [{ path: "data/stations.csv", search: rows.slice(2).join("\n") + "\n", replace: `${rows[3]}\n` }] },
    { summary: "trim spaces around names", edits: [{ path: "data/stations.csv", search: rows[2], replace: `2,${names[1]},48.85,2.35` }] },
    { summary: "remove the duplicate station 3", edits: [{ path: "data/stations.csv", search: `${rows[3]}\n${rows[4]}\n`, replace: `${rows[3]}\n` }] },
    { summary: "swap the lat and lon of station 4", edits: [{ path: "data/stations.csv", search: rows[5], replace: `4,${names[3]},7.0,140.0` }] },
    { summary: "use commas in the row of station 5", edits: [{ path: "data/stations.csv", search: rows[6], replace: `5,${names[4]},45.46,9.19` }] },
  ];
  write(work, "menu.json", JSON.stringify(menu));
  const proposer = writeMenuProposer(join(work, "propose.mjs"), join(work, "menu.json"), join(work, "proposer.log"), true);
  const file = problemFile(repo.dir, "csv.problem.json", {
    name: `stations-${word(r)}`, goal: "Clean the station list so every row is valid.",
    artifact: ["data/*.csv"], protect: ["measure/**"],
    measure: { command: "node measure/quality.js", direction: "higher", unit: "points", runs: 1 },
    proposer: { command: `node ${JSON.stringify(proposer)}` },
    budget: { max_rounds: 8 },
  });
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");

  const { result } = await solve(file, join(work, "out"));
  approx(result.baseline, 80, "result.json baseline");
  approx(result.final, 150, "result.json final");
  assert.equal(result.attempts.find((a) => a.summary === menu[0].summary)?.kept, false, "dropping the rows that fail is refused");
  assert.deepEqual(keptAttempts(result).map((a) => a.summary).sort(), menu.slice(1).map((m) => m.summary).sort(), "the four cleaning fixes are kept");
  const kept = fileOnBranch(repo, result, "data/stations.csv").trim().split("\n");
  assert.deepEqual(kept, ["id,name,lat,lon", `1,${names[0]},51.50,-0.12`, `2,${names[1]},48.85,2.35`, `3,${names[2]},52.52,13.40`, `4,${names[3]},7.0,140.0`, `5,${names[4]},45.46,9.19`], "the branch holds the clean CSV with every station");
});
