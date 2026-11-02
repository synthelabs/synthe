import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { GOAL_FILE, STATE_BRANCH, parseGoal, parseScenarios } from "../core/goal.ts";
import { judgeRound } from "../core/merge-rule.ts";
import { readPrompt } from "../core/prompt.ts";
import { isFinished, newState, type State } from "../core/state.ts";
import { anthropicModel } from "../model/client.ts";
import { measureNoise, runScore } from "../loop/score.ts";
import { runWrite } from "../loop/write.ts";
import { init, type Io } from "./init.ts";

const run: Io["run"] = (cmd, args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} failed`))));
  child.stdin.end(stdin ?? "");
});

async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function askSecret(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(question);
  (rl as any)._writeToOutput = () => {};
  const answer = await rl.question("");
  rl.close();
  process.stdout.write("\n");
  return answer;
}

const template = () => readFileSync(new URL("../templates/synthe.yml", import.meta.url), "utf8");
const io: Io = { say: console.log, ask, askSecret, run, model: anthropicModel, template };

async function status() {
  const slug = (await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  const raw = await run("gh", ["api", `repos/${slug}/contents/state.json?ref=${encodeURIComponent(STATE_BRANCH)}`, "-H", "Accept: application/vnd.github.raw+json"]);
  const s: State = JSON.parse(raw);
  const merged = s.rounds.filter((r) => r.outcome === "merged").length;
  console.log(`Round ${s.round}, ${merged} merged, $${s.spendUsd.toFixed(2)} spent. ${s.stopped ? `${isFinished(s.stopped) ? "Finished" : "Stopped"}: ${s.stopped}.` : "Running."}`);
  if (s.issue) console.log(`Report: https://github.com/${slug}/issues/${s.issue}`);
}

// Runs one round locally and changes nothing.
async function tryRound() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY first.");
  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const prompt = readPrompt(readFileSync(goal.prompt.path, "utf8"), goal, null);
  if (prompt === null) throw new Error("Prompt not found.");
  const scenarios = parseScenarios(readFileSync(goal.scenarios, "utf8"));
  const model = anthropicModel(key);
  if (process.argv.includes("--noise")) {
    const { points, costUsd } = await measureNoise(goal, prompt, scenarios, model);
    console.log(`Noise: ${points === null ? "unknown" : `${points.toFixed(1)} points`}. Cost: ${costUsd === null ? "unknown" : `${costUsd.toFixed(4)}`}`);
    return;
  }
  const written = await runWrite(goal, newState(), prompt, scenarios, model);
  const { scores, costUsd } = await runScore(goal, prompt, written.candidates, scenarios, model);
  console.log(JSON.stringify(judgeRound(scores, goal, null), null, 2));
  console.log(`Cost: ${written.costUsd === null || costUsd === null ? "unknown" : `$${(written.costUsd + costUsd).toFixed(4)}`}`);
}

const HELP = `synthe init    set up this repo and start improving
synthe status  show progress
synthe stop    stop all runs
synthe try     run one round locally, changing nothing
               add --noise to score your prompt twice and see how noisy scores are`;

async function main() {
  const command = process.argv[2];
  if (command === "init") process.exitCode = (await init(io, process.cwd())) ? 0 : 1;
  else if (command === "stop") { await run("gh", ["workflow", "disable", "synthe.yml"]); console.log("Stopped. Nothing else will merge."); }
  else if (command === "status") await status();
  else if (command === "try") await tryRound();
  else console.log(HELP);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
