import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { GOAL_FILE, STATE_BRANCH, parseGoal, parseScenarios } from "../core/goal.ts";
import { readPrompt } from "../core/prompt.ts";
import { newState, type State } from "../core/state.ts";
import { sha256 } from "../core/safety.ts";
import { headline } from "../loop/report.ts";
import { anthropicModel, modelProblem } from "../model/client.ts";
import { measureNoise } from "../loop/score.ts";
import { runLocalTry } from "./try-round.ts";
import { init, type Io } from "./init.ts";
import { calibrate } from "./calibrate.ts";
import { migrate } from "./migrate.ts";
import { restartState } from "./restart.ts";
import { stoppedLine } from "./stopped.ts";
import { askSecret } from "./secret.ts";
import { upgrade } from "./upgrade.ts";

const run: Io["run"] = (cmd, args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} failed`))));
  // A command that exits without reading its stdin (a stub `gh`, a fast failure) closes the pipe first;
  // without this, that surfaces as an unhandled EPIPE and crashes the CLI instead of reporting the failure.
  child.stdin.on("error", () => {});
  child.stdin.end(stdin ?? "");
});

async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

const template = () => readFileSync(new URL("../templates/synthe.yml", import.meta.url), "utf8");
const io: Io = { say: console.log, ask, askSecret, run, model: anthropicModel, template, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// Each command checks it's in a set-up project first, so a team gets a next step instead of a raw error.
function setUpHere(): boolean {
  if (existsSync(GOAL_FILE)) return true;
  console.log("Synthe isn't set up in this folder. Run `npx synthe init` inside your project's folder first.");
  process.exitCode = 1;
  return false;
}

async function repoSlug(): Promise<string | null> {
  try {
    return (await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  } catch {
    console.log("Couldn't reach this project on GitHub. Check you're signed in to the GitHub CLI (`gh auth status`) and inside your project's folder.");
    process.exitCode = 1;
    return null;
  }
}

async function status() {
  if (!setUpHere()) return;
  const slug = await repoSlug();
  if (!slug) return;
  const stopped = await stoppedLine(run, slug);
  if (stopped) console.log(stopped);
  let raw: string;
  try {
    raw = await run("gh", ["api", `repos/${slug}/contents/state.json?ref=${encodeURIComponent(STATE_BRANCH)}`, "-H", "Accept: application/vnd.github.raw+json"]);
  } catch {
    console.log("Synthe is set up but hasn't finished a round yet. Check its Actions run, or start it with `gh workflow run synthe.yml`.");
    console.log(`Watch it: https://github.com/${slug}/actions/workflows/synthe.yml`);
    return;
  }
  const s: State = { ...newState(), ...JSON.parse(raw) };
  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const { title, summary } = headline(goal, s, Boolean(stopped));
  console.log(title);
  // The summary is written for the report issue; in a terminal, "this page" is the issue, which is linked below.
  console.log(summary.replace(" This page updates after each round.", " The report updates after each round."));
  console.log(goal.merge_rule.mode === "propose" ? "Mode: review." : "Mode: automatic merging.");
  if (s.issue) console.log(`Full report: https://github.com/${slug}/issues/${s.issue}`);
}

async function stop() {
  if (!setUpHere()) return;
  try {
    await run("gh", ["workflow", "disable", "synthe.yml"]);
  } catch (e) {
    console.log(`Couldn't stop Synthe: ${(e as Error).message.trim().split("\n")[0]}`);
    console.log("Check you're signed in to the GitHub CLI (`gh auth status`), inside your project's folder.");
    process.exitCode = 1;
    return;
  }
  console.log("Stopped. Synthe won't run or change anything again. To start it again: npx synthe restart");
}

// Starts Synthe again after `npx synthe stop`, or once a person has fixed what stopped it.
async function restart() {
  if (!setUpHere()) return;
  const slug = await repoSlug();
  if (!slug) return;
  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const path = `repos/${slug}/contents/state.json`;
  let file: { sha: string; content: string } | null = null;
  try {
    file = JSON.parse(await run("gh", ["api", `${path}?ref=${encodeURIComponent(STATE_BRANCH)}`]));
  } catch { /* no round has finished yet, so there's no state to clear */ }
  let note = "";
  if (file) {
    const s: State = { ...newState(), ...JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) };
    const next = restartState(goal, s, existsSync(goal.scenarios) ? sha256(readFileSync(goal.scenarios, "utf8")) : null);
    if ("why" in next) {
      console.log(`Synthe can't start again. ${next.why}`);
      process.exitCode = 1;
      return;
    }
    if (next.state !== s) {
      const content = Buffer.from(`${JSON.stringify(next.state, null, 2)}\n`).toString("base64");
      await run("gh", ["api", "-X", "PUT", path, "-f", "message=Synthe: restarted by npx synthe restart", "-f", `branch=${STATE_BRANCH}`, "-f", `sha=${file.sha}`, "-f", `content=${content}`]);
      note = ` ${next.note}`;
    }
  }
  try {
    await run("gh", ["workflow", "enable", "synthe.yml"]);
    await run("gh", ["workflow", "run", "synthe.yml"]);
  } catch (e) {
    console.log(`Couldn't start Synthe's workflow: ${(e as Error).message.trim().split("\n")[0]}`);
    console.log("Check you're signed in to the GitHub CLI (`gh auth status`), inside your project's folder.");
    process.exitCode = 1;
    return;
  }
  console.log(`Started again.${note} GitHub accepted the dispatch. Completed rounds start back to back.`);
  console.log(`Watch it: https://github.com/${slug}/actions/workflows/synthe.yml`);
}

// Loads what a round on this computer needs, or says what's missing. Used by try and calibrate.
function localRun(command: string) {
  if (!setUpHere()) return null;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log(`\`npx synthe ${command}\` runs on your computer, changing nothing, and needs your Synthe key:`);
    console.log(`  ANTHROPIC_API_KEY=your-key npx synthe ${command}`);
    process.exitCode = 1;
    return null;
  }
  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const prompt = readPrompt(readFileSync(goal.prompt.path, "utf8"), goal, null);
  if (prompt === null) {
    console.log(`Couldn't find your prompt in ${goal.prompt.path}. If you moved or rewrote it, update prompt in ${GOAL_FILE}.`);
    process.exitCode = 1;
    return null;
  }
  return { goal, prompt, scenarios: parseScenarios(readFileSync(goal.scenarios, "utf8")), model: anthropicModel(key) };
}

// Checks whether the team's checks are marked steadily, and the way the team means them.
async function calibrateChecks() {
  const local = localRun("calibrate");
  if (!local) return;
  const result = await calibrate({ say: console.log, ask }, local.goal, local.prompt, local.scenarios, local.model);
  if (!result) return;
  // Rewordings the team made during the questions are saved, so the next round measures what they mean.
  if (result.checks.some((c, i) => c !== local.goal.checks?.[i])) {
    const saved = JSON.parse(readFileSync(GOAL_FILE, "utf8"));
    writeFileSync(GOAL_FILE, `${JSON.stringify({ ...saved, checks: result.checks }, null, 2)}\n`);
    console.log(`\nSaved your reworded checks in ${GOAL_FILE}. Push them so Synthe's next round uses them:`);
    console.log(`  git commit -m "Reword Synthe checks" ${GOAL_FILE} && git push`);
  }
  if (result.results.some((r) => r.verdict !== "trustworthy")) process.exitCode = 1;
}

// Runs one round on this computer without changing the prompt, so a team can see what Synthe would do.
async function tryRound() {
  const local = localRun("try");
  if (!local) return;
  const { goal, prompt, scenarios, model } = local;
  if (process.argv.includes("--noise")) {
    console.log("Comparing your prompt with itself on every test case...");
    const n = await measureNoise(goal, prompt, scenarios, model);
    console.log(n.wins === null
      ? "Some replies couldn't be judged, so this can't say how much the judge varies."
      : `Your prompt against itself: better in ${n.wins} test cases, worse in ${n.losses}, the same in ${n.ties}. The prompts are identical, so any lean is just the judge varying. A real improvement has to beat that clearly.`);
    console.log(`Cost: ${n.costUsd === null ? "unknown" : `$${n.costUsd.toFixed(2)}`}`);
    return;
  }
  console.log("Trying one round on your computer. Your prompt stays unchanged; candidate fingerprints are saved in .synthe-local/try-history.json...");
  const { written, costUsd, verdict } = await runLocalTry(process.cwd(), goal, prompt, scenarios, model);
  for (const c of written.candidates) console.log(`- ${c.title ?? c.summary ?? c.id}: ${verdict.notes[c.id] ?? "not tested"}`);
  for (const r of written.rejected ?? []) console.log(`- An edit that couldn't be applied: ${r.replace(/^candidate-\d+: /, "")}`);
  console.log(verdict.action === "merge" ? `In a real run, Synthe would merge this. ${verdict.plain}` : "In a real run, nothing would change this round.");
  console.log(`Cost: ${written.costUsd === null || costUsd === null ? "unknown" : `$${(written.costUsd + costUsd).toFixed(2)}`}`);
}

const HELP = `Synthe makes your AI agent's system prompt better while you sleep.

Start here, inside your project's folder:
  npx synthe init     set up this repo and start

Then:
  npx synthe status   where it is and what it changed
  npx synthe upgrade  update only the installed workflow for chained rounds
  npx synthe stop     stop it; nothing more runs or changes
  npx synthe restart  start it again, after stop or once you've fixed what stopped it
  npx synthe try      run one round on your computer without changing your prompt (needs ANTHROPIC_API_KEY)
  npx synthe try --noise   compare your prompt with itself, to see how much the judge varies
  npx synthe calibrate     check that your checks are marked steadily and the way you mean them (needs ANTHROPIC_API_KEY)
  npx synthe migrate --to <model>   compare your prompt on another model, changing nothing (needs ANTHROPIC_API_KEY; add --dry-run to spend nothing)

More: https://github.com/synthelabs/synthe#readme`;

async function main() {
  const command = process.argv[2];
  if (command === "init") process.exitCode = (await init(io, process.cwd())) ? 0 : 1;
  else if (command === "upgrade") console.log(upgrade(process.cwd(), template()));
  else if (command === "stop") await stop();
  else if (command === "status") await status();
  else if (command === "restart") await restart();
  else if (command === "try") await tryRound();
  else if (command === "calibrate") await calibrateChecks();
  else if (command === "migrate") process.exitCode = await migrate(process.argv.slice(3), { cwd: process.cwd(), say: console.log, apiKey: process.env.ANTHROPIC_API_KEY });
  else console.log(HELP);
}

main().catch((e) => {
  const problem = modelProblem(e);
  if (problem) {
    console.error(problem);
    if (process.argv[2] === "init") console.error("Nothing in your repo was changed. Then run `npx synthe init` again.");
  } else {
    console.error(`Synthe hit an error: ${e.message}`);
    console.error("If this keeps happening, open an issue at https://github.com/synthelabs/synthe/issues");
  }
  process.exit(1);
});
