// The enterprise pilot's commands, as one function. This module has no side effects when imported, so the main
// Synthe CLI loads it for `npx synthe pilot` (src/cli/main.ts). From a checkout the entry point is src/pilot/cli.ts.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as commands from "./commands.ts";
import type { Flags, PilotDeps } from "./commands.ts";
import { PilotError } from "./errors.ts";
import { exportLog, writeLogExport } from "./export.ts";
import { printable } from "./io.ts";
import { PilotStore } from "./store.ts";
import { watch, type LogExporter } from "./watch.ts";
import { cases } from "./cases.ts";

export const DEFAULT_DIR = ".synthe-pilot";
// How the person started the pilot, so help and hints name a command they can type: `npx synthe pilot` from the
// product CLI, this from a checkout.
export const CHECKOUT_PROG = "node src/pilot/cli.ts";
export const GUIDE_URL = "https://github.com/synthelabs/synthe/blob/main/docs/PILOT.md";

export const helpText = (prog: string): string => `Synthe enterprise pilot: one agent, one metric, reviewed changes, a keep / hold / revert recommendation.

  ${prog} <command> [--dir <pilot directory>] [options]      (default directory: ${DEFAULT_DIR})

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
  experiment  --candidate <id> --start <UTC time> [--share 0.5] [--allow-past-start] [--accept-flags a,b]   write the specification the customer runs
              (the start must be in the future; --allow-past-start is for a split that already began, and holds the result)
  review      --candidate <id>                          write the local review bundle (nothing is published)
              --publish --repo <owner/name> --base <branch> --confirm <full candidate id>   open the pull request
  approve     --candidate <full id> --experiment <full id> --approver <name> [--reject]
  analyze     --experiment <id> [--telemetry <export.json>] [--reopen]   keep, hold or revert, from the customer's outcome export
  watch       --inbox <dir> | --log <dir> --assignment randomized|observational [--experiment <id>] [--interim-days N]   one scheduled tick: analyse only at allowed looks; never publishes
  export      --log <dir> --experiment <id> --assignment randomized|observational [--agent <name>] [--out <dir>]   turn the recorder's call log into the outcome export
              --log <dir> --baseline --start <UTC time> --end <UTC time>                                              a baseline export from the log

Close the loop
  promote     --list | --request <request.json>         approved failures become regression cases in a new pack version
  cases       --replay <id> [--out <file>]              the current prompt's failures as candidate scenarios.jsonl lines for a person to review
  report                                                rebuild the evidence summary (reports/PILOT.md)
  verify      [--head <journal head>]                   recheck every record and recompute every decision; with --head,
                                                        also check the journal still holds the entry you noted earlier
  status                                                where the pilot stands

  demo        --out <directory>                         run the whole loop on synthetic data (no credentials, no network)

A live model provider is used only with --live --confirm-endpoint <url> --confirm-data "<data class>" (a host other than api.anthropic.com also needs --allow-endpoint-host <host>), and only when
pilot.json records the customer's approval. Everything stays in the pilot directory unless you publish a review.
Guide: docs/PILOT.md (${GUIDE_URL})`;

const OPTIONS = {
  dir: { type: "string" }, config: { type: "string" }, "repo-dir": { type: "string" }, rev: { type: "string" },
  telemetry: { type: "string" }, file: { type: "string" }, model: { type: "string" }, proposer: { type: "string" },
  finding: { type: "string" }, author: { type: "string" }, rationale: { type: "string" }, candidate: { type: "string" },
  start: { type: "string" }, end: { type: "string" }, log: { type: "string" }, assignment: { type: "string" }, agent: { type: "string" }, share: { type: "string" }, repo: { type: "string" }, base: { type: "string" }, confirm: { type: "string" },
  experiment: { type: "string" }, approver: { type: "string" }, request: { type: "string" }, replay: { type: "string" }, out: { type: "string" },
  "confirm-endpoint": { type: "string" }, "allow-endpoint-host": { type: "string" }, "confirm-data": { type: "string" }, head: { type: "string" },
  publish: { type: "boolean" }, baseline: { type: "boolean" }, "allow-past-start": { type: "boolean" }, reopen: { type: "boolean" }, "accept-flags": { type: "string" }, inbox: { type: "string" }, "interim-days": { type: "string" }, live: { type: "boolean" }, reject: { type: "boolean" }, list: { type: "boolean" }, help: { type: "boolean" },
} as const;

// What `watch --log` calls at a due look: the same export `pilot export` writes, into the pilot directory's exports/.
const realLogExporter = (agent: string | undefined): LogExporter => (i) => {
  const out = writeLogExport({ store: i.store, logDir: i.logDir, scope: { experiment: i.experimentId }, assignment: i.assignment as "randomized" | "observational", now: i.now, ...(agent ? { agent } : {}) });
  return { path: out.path, notes: out.notes };
};

type Command = (store: PilotStore, flags: Flags, deps: PilotDeps) => Promise<number>;
const COMMANDS: Record<string, Command> = {
  init: commands.init, baseline: commands.baseline, pack: commands.pack, discover: commands.discover, propose: commands.propose,
  replay: commands.replay, experiment: commands.experiment, review: commands.review, approve: commands.approve, analyze: commands.analyze,
  export: exportLog, watch: (store, flags, deps) => watch(store, flags, deps, realLogExporter(typeof flags.agent === "string" && flags.agent.trim() !== "" ? flags.agent : undefined)),
  promote: commands.promotePack, cases, report: commands.report, verify: commands.verify, status: commands.status,
};

export async function main(argv: string[], deps: PilotDeps, prog: string = CHECKOUT_PROG): Promise<number> {
  const name = argv[0];
  if (!name || name === "help" || name === "--help" || name === "-h") { deps.say(helpText(prog)); return name ? 0 : 1; }
  let flags: Flags;
  try {
    flags = parseArgs({ args: argv.slice(1), options: OPTIONS, strict: true, allowPositionals: false }).values as Flags;
  } catch (e) {
    deps.say(`${(e as Error).message}. Run \`${prog} help\` for the options.`);
    return 1;
  }
  if (flags.help === true) { deps.say(helpText(prog)); return 0; }
  try {
    if (name === "demo") {
      // Loaded on demand: the demo carries a fake GitHub server and a data generator the real commands never need.
      const { demo } = await import("./demo.ts");
      return await demo(flags, deps, prog);
    }
    const command = COMMANDS[name];
    if (!command) { deps.say(`"${name}" is not a pilot command. Run \`${prog} help\` for the list.`); return 1; }
    return await command(new PilotStore(resolve(typeof flags.dir === "string" ? flags.dir : DEFAULT_DIR)), flags, deps);
  } catch (e) {
    if (e instanceof PilotError) {
      // Some refusals quote a value from the customer's files (a prompt version, a name): flattened, so a control
      // sequence in it cannot move the cursor or rewrite earlier output.
      deps.say(`Refused (${e.code}): ${printable(e.message, 2000)}`);
      return 1;
    }
    // An unexpected failure. Its message is not printed by default: an error from a parser, a provider or git
    // can quote the data it choked on.
    const kind = e instanceof Error ? e.name : "error";
    if (deps.env.SYNTHE_PILOT_DEBUG === "1") deps.say(`The pilot command hit an unexpected ${kind}: ${(e as Error).message}`);
    else deps.say(`The pilot command hit an unexpected ${kind} and stopped. Nothing after that point was recorded, so it is safe to run the command again. To see the error text (it may quote your data), run it again with SYNTHE_PILOT_DEBUG=1.`);
    return 1;
  }
}

export const defaultDeps = (): PilotDeps => ({ say: (line) => console.log(line), env: process.env, now: () => new Date() });
