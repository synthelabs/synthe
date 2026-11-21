import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ImproveConfig } from "../../src/improve/config.ts";
import { shellExec } from "../../src/improve/exec.ts";
import { lastNumber } from "../../src/improve/presets.ts";
import { runLoop, type LoopIo } from "../../src/improve/loop.ts";
import { measureAt } from "../../src/improve/worktree.ts";
import type { Ask, Model } from "../../src/model/client.ts";
import { shuffle } from "../rng.ts";
import type { Change, ChangeKind, Fixture } from "./fixtures.ts";

export interface ImproveRun {
  fixture: string;
  seed: string;
  rounds: number;
  start: number;
  end: number;
  realKept: number;
  falseKeeps: number; // noise-level or gaming changes kept
  gamingKept: number;
  noiseKept: number;
  realMissed: number;
  heldOff: number; // changes that won their first measurement but not the fresh re-measure, so were not kept
  kept: string[];
  calls: { pick: number; propose: number };
  metricRuns: number; // metric runs whose number counted, including the starting measurement
  stopped: string;
}

// The scripted writer: each round picks the file of the next change in the seeded order and proposes it in the
// improve writer's own reply format. It answers the two calls a round makes, told apart by their schemas.
function scriptedWriter(order: Change[]) {
  const calls = { pick: 0, propose: 0 };
  let n = -1;
  const model: Model = {
    async ask(a: Ask) {
      const props = (a.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if ("paths" in props) {
        calls.pick++;
        n++;
        const c = order[n];
        return { text: JSON.stringify({ paths: c ? [c.path] : [], why: "the change touches this file" }), costUsd: 0.004 };
      }
      if ("edits" in props) {
        calls.propose++;
        const c = order[n];
        return { text: JSON.stringify(c ? { summary: c.summary, edits: [{ path: c.path, search: c.search, replace: c.replace }] } : { summary: "nothing more", edits: [] }), costUsd: 0.02 };
      }
      throw new Error(`The improve bench's writer got a call it doesn't recognise (schema keys: ${Object.keys(props).join(", ")}). Teach bench/improve/run.ts to answer it.`);
    },
  };
  return { model, calls };
}

// Builds the fixture as a git repo in a temp folder, measures its starting point with the real measurement code,
// then runs the real improve loop for one round per change on the menu.
export async function runFixture(f: Fixture, seed: string): Promise<ImproveRun> {
  const work = mkdtempSync(join(tmpdir(), "synthe-bench-"));
  try {
    const dir = join(work, "repo");
    const noisePath = join(work, "noise-counter");
    // No global or system git config, so the bench behaves the same on every machine.
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv, stdio: ["pipe", "pipe", "pipe"] }).trim();
    mkdirSync(dir);
    git("init", "-q", "-b", "main");
    git("config", "user.email", "bench@example.com");
    git("config", "user.name", "bench");
    for (const [path, text] of Object.entries(f.files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text.replaceAll("NOISE_PATH", JSON.stringify(noisePath)).replaceAll("SEED_VALUE", JSON.stringify(`${seed}:${f.name}`)));
    }
    git("add", ".");
    git("commit", "-qm", "Fixture");
    const head = git("rev-parse", "HEAD");

    const config: ImproveConfig = {
      version: 1, goal: f.measures, protect: [], mode: "review",
      metric: { preset: "custom", label: f.label, unit: f.unit, command: f.metric, direction: f.direction, runs: 3 },
      guard: { command: f.guard },
      baseline: { commit: head, median: 0, runs: [], at: "" },
    };
    const start = await measureAt(shellExec, dir, head, config);
    if (!start.measurement) throw new Error(`${f.name}: the fixture's metric gave no number (${start.reason})`);
    config.baseline = start.measurement;

    const order = shuffle(f.menu, seed, f.name, "menu");
    const { model, calls } = scriptedWriter(order);
    // Metric runs are counted at the shell: each run of the metric command that printed a number. The loop has no
    // hooks of its own to report measurements.
    let metricRuns = start.measurement.runs.length;
    const io: LoopIo = {
      say: () => {},
      exec: async (cwd, command, timeoutMs) => {
        const r = await shellExec(cwd, command, timeoutMs);
        if (command === config.metric.command && r.ok && lastNumber(r.stdout) !== null) metricRuns++;
        return r;
      },
      run: async (cmd, args, stdin) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", input: stdin, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] }),
    };
    const result = await runLoop(io, { top: dir, gitDir: join(dir, ".git"), config, model, rounds: order.length, budgetUsd: 10 });
    const kinds: ChangeKind[] = result.rounds.filter((r) => r.kept).map((r) => order.find((c) => c.summary === r.summary)!.kind);
    const kept = result.rounds.filter((r) => r.kept).map((r) => order.find((c) => c.summary === r.summary)!.id);
    return {
      fixture: f.name, seed, rounds: result.rounds.length, start: start.measurement.median, end: result.best.median,
      realKept: kinds.filter((k) => k === "real").length, falseKeeps: kinds.filter((k) => k !== "real").length,
      gamingKept: kinds.filter((k) => k === "gaming").length, noiseKept: kinds.filter((k) => k === "noise").length,
      realMissed: f.menu.filter((c) => c.kind === "real" && !kept.includes(c.id)).length,
      heldOff: result.rounds.filter((r) => !r.kept && r.why.startsWith("did not hold")).length,
      kept, calls: { ...calls }, metricRuns, stopped: result.stopped,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
