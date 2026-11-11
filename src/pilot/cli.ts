// The enterprise pilot's entry point. Run it from a checkout:
//
//   node src/pilot/cli.ts <command> --dir <pilot directory> [options]
//   node src/pilot/cli.ts demo --out <directory>        the whole loop on synthetic data, no credentials
//
// It is deliberately not wired into `npx synthe` yet (src/cli/main.ts and the committed bundles belong to other
// work in flight); docs/PILOT.md lists the wiring that remains. `node scripts/pilot-build.mjs` bundles this file.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as commands from "./commands.ts";
import type { Flags, PilotDeps } from "./commands.ts";
import { PilotError } from "./errors.ts";
import { PilotStore } from "./store.ts";

export const DEFAULT_DIR = ".synthe-pilot";

export const HELP = `Synthe enterprise pilot: one agent, one metric, reviewed changes, a keep / hold / revert recommendation.

  node src/pilot/cli.ts <command> [--dir <pilot directory>] [options]      (default directory: ${DEFAULT_DIR})

Set up
  init        --config pilot.json --repo-dir <customer checkout> [--rev <commit>]   freeze the contract and baseline prompt
  baseline    --telemetry <export.json>                 import the customer's baseline export, write the baseline report
  pack        --file <pack.json>                        freeze the redacted conversation pack

Find and test a change
  discover    --model scripted:<file> | --live ...      replay the baseline, list recurring failures (discovery cases)
  propose     --finding <id> --proposer scripted:<file> | --live ...            one narrow change from a proposer
              --file <prompt> --author <name> --rationale <why> [--finding <id>] or one a person wrote
  replay      --candidate <id> --model scripted:<file> | --live ...             both prompts on the same frozen cases

Review and experiment
  experiment  --candidate <id> --start <UTC time> [--share 0.5]   write the specification the customer runs
  review      --candidate <id>                          write the local review bundle (nothing is published)
              --publish --repo <owner/name> --base <branch> --confirm <full candidate id>   open the pull request
  approve     --candidate <full id> --experiment <full id> --approver <name> [--reject]
  analyze     --experiment <id> [--telemetry <export.json>]   keep, hold or revert, from the customer's outcome export

Close the loop
  promote     --list | --request <request.json>         approved failures become regression cases in a new pack version
  report                                                rebuild the evidence summary (reports/PILOT.md)
  verify                                                recheck every record and recompute every decision
  status                                                where the pilot stands

  demo        --out <directory>                         run the whole loop on synthetic data (no credentials, no network)

A live model provider is used only with --live --confirm-endpoint <url> --confirm-data "<data class>", and only when
pilot.json records the customer's approval. Everything stays in the pilot directory unless you publish a review.
Guide: docs/PILOT.md`;

const OPTIONS = {
  dir: { type: "string" }, config: { type: "string" }, "repo-dir": { type: "string" }, rev: { type: "string" },
  telemetry: { type: "string" }, file: { type: "string" }, model: { type: "string" }, proposer: { type: "string" },
  finding: { type: "string" }, author: { type: "string" }, rationale: { type: "string" }, candidate: { type: "string" },
  start: { type: "string" }, share: { type: "string" }, repo: { type: "string" }, base: { type: "string" }, confirm: { type: "string" },
  experiment: { type: "string" }, approver: { type: "string" }, request: { type: "string" }, out: { type: "string" },
  "confirm-endpoint": { type: "string" }, "confirm-data": { type: "string" },
  publish: { type: "boolean" }, live: { type: "boolean" }, reject: { type: "boolean" }, list: { type: "boolean" }, help: { type: "boolean" },
} as const;

type Command = (store: PilotStore, flags: Flags, deps: PilotDeps) => Promise<number>;
const COMMANDS: Record<string, Command> = {
  init: commands.init, baseline: commands.baseline, pack: commands.pack, discover: commands.discover, propose: commands.propose,
  replay: commands.replay, experiment: commands.experiment, review: commands.review, approve: commands.approve, analyze: commands.analyze,
  promote: commands.promotePack, report: commands.report, verify: commands.verify, status: commands.status,
};

export async function main(argv: string[], deps: PilotDeps): Promise<number> {
  const name = argv[0];
  if (!name || name === "help" || name === "--help" || name === "-h") { deps.say(HELP); return name ? 0 : 1; }
  let flags: Flags;
  try {
    flags = parseArgs({ args: argv.slice(1), options: OPTIONS, strict: true, allowPositionals: false }).values as Flags;
  } catch (e) {
    deps.say(`${(e as Error).message}. Run \`node src/pilot/cli.ts help\` for the options.`);
    return 1;
  }
  if (flags.help === true) { deps.say(HELP); return 0; }
  try {
    if (name === "demo") {
      // Loaded on demand: the demo carries a fake GitHub server and a data generator the real commands never need.
      const { demo } = await import("./demo.ts");
      return await demo(flags, deps);
    }
    const command = COMMANDS[name];
    if (!command) { deps.say(`"${name}" is not a pilot command. Run \`node src/pilot/cli.ts help\` for the list.`); return 1; }
    return await command(new PilotStore(resolve(typeof flags.dir === "string" ? flags.dir : DEFAULT_DIR)), flags, deps);
  } catch (e) {
    if (e instanceof PilotError) {
      deps.say(`Refused (${e.code}): ${e.message}`);
      return 1;
    }
    // An unexpected failure: the message only, never a dump of the data being handled.
    deps.say(`The pilot command hit an error: ${(e as Error).message}`);
    return 1;
  }
}

export const defaultDeps = (): PilotDeps => ({ say: (line) => console.log(line), env: process.env, now: () => new Date() });

const invoked = (): boolean => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};
if (invoked()) {
  main(process.argv.slice(2), defaultDeps()).then((code) => { process.exitCode = code; }, (e) => { console.error(`The pilot command hit an error: ${(e as Error).message}`); process.exitCode = 1; });
}
