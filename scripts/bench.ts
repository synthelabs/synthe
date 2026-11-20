// Free, seeded benchmark of the whole optimizer: scripted tasks with known true gains, neutral edits and traps, run
// through the real round code (prompt mode) and the real improve loop (improve mode). See bench/README.md.
//   npm run bench                          run, print the table, write bench/results.json
//   npm run bench -- --check               run, then fail if false keeps rose or real gains fell against bench/baseline.json
//   npm run bench -- --check --results F   check an existing results file without running
//   npm run bench -- --update-baseline     run and write bench/baseline.json (a maintainer does this on main)
//   npm run bench -- --live                real judge and checker calls; refuses unless SYNTHE_BENCH_LIVE=1
import { readFileSync, writeFileSync } from "node:fs";
import { askLine, checkResults, diffLines, formatTable, runBench, runLive, type Results } from "../bench/bench.ts";

const BASELINE = "bench/baseline.json";
const RESULTS = "bench/results.json";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const known = new Set(["--check", "--results", "--update-baseline", "--live"]);

async function main(): Promise<number> {
  const unknown = args.filter((a, i) => !known.has(a) && args[i - 1] !== "--results");
  if (unknown.length) {
    console.error(`Unknown option ${unknown[0]}. Options: --check, --results <file>, --update-baseline, --live.`);
    return 2;
  }
  if (flag("--live")) {
    const r = await runLive({ env: process.env, say: (t) => console.log(t), ask: askLine });
    if (!r) return 2;
    console.log(formatTable(r));
    writeFileSync("bench/results-live.json", JSON.stringify(r, null, 2) + "\n");
    console.log("Wrote bench/results-live.json. Live numbers are not compared with the baseline.");
    return 0;
  }
  const from = value("--results");
  let results: Results;
  if (from) {
    results = JSON.parse(readFileSync(from, "utf8"));
  } else {
    const started = Date.now();
    results = await runBench();
    console.log(formatTable(results));
    writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nWrote ${RESULTS} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    if (flag("--update-baseline")) {
      writeFileSync(BASELINE, JSON.stringify(results, null, 2) + "\n");
      console.log(`Wrote ${BASELINE}. Update it only from main, so every branch is judged against the same numbers.`);
    }
  }
  if (!flag("--check")) return 0;
  const base: Results = JSON.parse(readFileSync(BASELINE, "utf8"));
  const problems = checkResults(results, base);
  for (const line of diffLines(results, base)) console.log(line);
  if (problems.length) {
    console.log(`\nCheck failed against ${BASELINE}:`);
    for (const p of problems) console.log(`- ${p}`);
    console.log("The lines above show which tasks moved. Fix the change, or explain the trade in the pull request.");
    return 1;
  }
  console.log(`\nCheck passed: no more false keeps and no fewer real gains than ${BASELINE}, within the tolerance.`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
