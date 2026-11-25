// `npm run bench -- --zoo [--seeds 1,2,3] [--only <problem>]`: one row for each zoo problem, and bench/zoo-results.json.
import { writeFileSync } from "node:fs";
import { formatZoo, listZoo, runZoo, SEEDS, ZOO_DIR, ZOO_RESULTS } from "./zoo.ts";

export async function zooMain(args: string[]): Promise<number> {
  const value = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const takesValue = ["--seeds", "--only"];
  const unknown = args.filter((a, i) => (a.startsWith("--") ? !takesValue.includes(a) : !takesValue.includes(args[i - 1])));
  if (unknown.length) { console.error(`Unknown option ${unknown[0]}. Options with --zoo: --seeds 1,2,3 and --only <problem>.`); return 2; }
  const seedText = value("--seeds");
  const seeds = seedText ? seedText.split(",").map(Number) : SEEDS;
  if (seeds.some((s) => !Number.isInteger(s) || s < 0)) { console.error("--seeds must be whole numbers with commas, such as --seeds 1,2,3."); return 2; }
  const only = value("--only");
  const problems = listZoo().filter((p) => !only || p.name === only);
  if (!problems.length) {
    console.error(only ? `No zoo problem is named "${only}" in ${ZOO_DIR}.` : `No zoo problems found in ${ZOO_DIR}. Each problem is a folder with one problem file.`);
    return 1;
  }
  const started = Date.now();
  const results = await runZoo(problems, seeds);
  console.log(formatZoo(results));
  writeFileSync(ZOO_RESULTS, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nRan ${problems.length} problems with seeds ${seeds.join(", ")} in ${Math.round((Date.now() - started) / 1000)} s. Wrote ${ZOO_RESULTS}.`);
  return 0;
}
