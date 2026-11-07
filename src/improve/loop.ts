import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sumCosts } from "../core/cost.ts";
import { modelProblem, type Model } from "../model/client.ts";
import type { ImproveConfig, Measurement } from "./config.ts";
import type { Exec } from "./exec.ts";
import { appendLessons, lessonLine, lessonsTarget, readLessons, upsertLessonsBlock } from "./lessons.ts";
import { formatValue, money, movement } from "./text.ts";
import { verdict } from "./verdict.ts";
import { measureAt } from "./worktree.ts";
import { candidateFiles, checkEdits, pickFiles, proposeEdits, shownFiles, type Tried, type WriterContext } from "./writer.ts";

export interface LoopIo { say(t: string): void; run(cmd: string, args: string[], stdin?: string): Promise<string>; exec: Exec }
export interface LoopOptions { top: string; gitDir: string; config: ImproveConfig; model: Model; rounds: number; budgetUsd: number }
export interface RoundRecord extends Tried { before: number; files: string[]; costUsd: number | null; commit?: string }
export interface LoopResult { best: Measurement; rounds: RoundRecord[]; spentUsd: number; costKnown: boolean; stopped: string; lessons: string[] }

export const DEFAULT_ROUNDS = 6;
export const DEFAULT_BUDGET_USD = 1.5;
export const MAX_MISSES = 3;
// Before any round has run there is nothing to estimate from; this is the per-round ceiling the writer is built for.
export const FIRST_ROUND_ESTIMATE_USD = 0.25;
// Used only when the person has no git identity, so a commit can still be made in the throwaway checkout.
export const SYNTHE_IDENTITY = ["-c", "user.name=Synthe", "-c", "user.email=synthe@users.noreply.github.com"];
const SCRATCH_PREFIX = "synthe-improve-";

const firstLine = (e: unknown) => ((e as Error)?.message ?? String(e)).trim().split("\n")[0];

// A detached checkout of one commit in a temp folder, removed on every path out.
async function withScratch<T>(io: LoopIo, top: string, commit: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  try {
    await io.run("git", ["-C", top, "worktree", "add", "--detach", "--quiet", dir, commit]);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Could not check out ${commit.slice(0, 7)}: ${firstLine(e)}`);
  }
  try {
    return await fn(dir);
  } finally {
    try { await io.run("git", ["-C", top, "worktree", "remove", "--force", dir]); } catch { /* removed below */ }
    try { await io.run("git", ["-C", top, "worktree", "prune"]); } catch { /* nothing to prune */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

// For Ctrl-C, where nothing async can finish: removes every temp checkout Synthe made of this repo, including the
// ones measureAt makes, by their folder name.
export function removeScratchCheckouts(top: string): void {
  try {
    const list = execFileSync("git", ["-C", top, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    // Only Synthe's own throwaway checkouts: directly in the system temp folder, named exactly like mkdtemp makes them,
    // and never the first entry (the person's own checkout), whatever its folder is called.
    const temp = realpathSync(tmpdir());
    const scratch = new RegExp(`^${SCRATCH_PREFIX}[A-Za-z0-9]{6}$`);
    const paths = list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
    for (const path of paths.slice(1)) {
      let parent = "";
      try { parent = realpathSync(dirname(path)); } catch { parent = dirname(path); }
      if (parent !== temp || !scratch.test(basename(path))) continue;
      // node_modules and venvs are links into the person's own folders: unlink them before removing anything.
      for (const name of ["node_modules", ".venv", "venv"]) try { rmSync(join(path, name)); } catch { /* not a link */ }
      try { execFileSync("git", ["-C", top, "worktree", "remove", "--force", path], { stdio: "ignore" }); } catch { /* pruned below */ }
      rmSync(path, { recursive: true, force: true });
    }
    execFileSync("git", ["-C", top, "worktree", "prune"], { stdio: "ignore" });
  } catch { /* best effort on the way out */ }
}

async function hasIdentity(io: LoopIo, dir: string): Promise<boolean> {
  const has = async (key: string) => { try { return Boolean((await io.run("git", ["-C", dir, "config", key])).trim()); } catch { return false; } };
  return (await has("user.name")) && (await has("user.email"));
}

// Commits exactly the given paths. Hooks are skipped and signing is off: this is a machine commit in a throwaway
// checkout, a signing prompt would hang the run, and the regression check is the gate that matters.
export async function commitPaths(io: LoopIo, dir: string, paths: string[], message: string, force = false): Promise<string> {
  await io.run("git", ["-C", dir, "add", ...(force ? ["-f"] : []), "--", ...paths]);
  const identity = (await hasIdentity(io, dir)) ? [] : SYNTHE_IDENTITY;
  await io.run("git", ["-C", dir, ...identity, "-c", "commit.gpgsign=false", "commit", "--no-verify", "--quiet", "-F", "-"], message);
  return (await io.run("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
}

// Why a measured change was not kept, short enough for one progress line.
function notKeptWhy(config: ImproveConfig, best: Measurement, candidate: Measurement, guardPassed: boolean | null): string | null {
  const v = verdict(config.metric.direction, best, candidate, guardPassed);
  if (v.win) return null;
  if (guardPassed === false) return "the regression check did not pass";
  const better = config.metric.direction === "higher" ? v.delta : -v.delta;
  const moved = movement(best.median, candidate.median, config.metric);
  if (better <= 0) return `not better: ${moved}`;
  return `within noise: ${moved}, and runs vary by up to ${formatValue(v.noise, config.metric.unit)}`;
}

export async function runLoop(io: LoopIo, o: LoopOptions): Promise<LoopResult> {
  const { config, top, gitDir, model } = o;
  const past = [...new Set([...readLessons(top), ...readLessons(gitDir)])].slice(-20);
  const rounds: RoundRecord[] = [];
  const lessons: string[] = [];
  let best = config.baseline;
  let spent = 0;
  let misses = 0;
  let stopped = "";
  let partialUnknown = false;

  const finish = (r: RoundRecord) => {
    rounds.push(r);
    if (r.costUsd !== null) spent += r.costUsd;
    misses = r.kept ? 0 : misses + 1;
    const cost = r.costUsd === null ? "Cost unknown." : `Cost ${money(r.costUsd)}, total ${money(spent)}.`;
    io.say(r.kept
      ? `Round ${r.round}: ${movement(r.before, r.value!, config.metric)}, kept (${r.summary}). ${cost}`
      : `Round ${r.round}: not kept (${r.why}). ${cost}`);
    const line = lessonLine({ round: r.round, kept: r.kept, summary: r.summary, before: r.before, after: r.value, unit: config.metric.unit, ...(r.kept ? {} : { why: r.why }) });
    lessons.push(line);
    // The local log lives inside .git, so the run never dirties the team's working tree.
    try { appendLessons(gitDir, [line]); } catch { /* a lesson that can't be saved doesn't stop the run */ }
  };

  for (let n = 1; ; n++) {
    if (n > o.rounds) { stopped = `Stopped after ${o.rounds} ${o.rounds === 1 ? "round" : "rounds"} (--rounds ${o.rounds}).`; break; }
    if (misses >= MAX_MISSES) { stopped = `Stopped after ${MAX_MISSES} rounds in a row without a win.`; break; }
    const unknown = rounds.find((r) => r.costUsd === null);
    if (unknown) { stopped = `Stopped: round ${unknown.round} cost an unknown amount, so Synthe can't keep the run within the ${money(o.budgetUsd)} budget.`; break; }
    const estimate = rounds.length ? Math.max(...rounds.map((r) => r.costUsd!)) : FIRST_ROUND_ESTIMATE_USD;
    if (spent + estimate > o.budgetUsd) { stopped = `Stopped before round ${n}: another round could cost about ${money(estimate)}, and ${money(spent)} of the ${money(o.budgetUsd)} budget (--budget) is spent.`; break; }

    const before = best.median;
    const spentThisRound: (number | null)[] = [];
    const miss = (summary: string, why: string, files: string[] = []): RoundRecord =>
      ({ round: n, summary, kept: false, value: null, why, before, files, costUsd: sumCosts(spentThisRound) });
    const skip = (summary: string, why: string, files: string[] = []) => ({ miss: miss(summary, why, files) });
    try {
      io.say(`Round ${n} of ${o.rounds}: reading the code and choosing what to change...`);
      const ctx: WriterContext = { config, best: best.median, tried: rounds, lessons: past };
      const proposed = await withScratch(io, top, best.commit, async (dir) => {
        const tracked = (await io.run("git", ["-C", dir, "ls-files", "-z"])).split("\0").filter(Boolean);
        const { files, more } = candidateFiles(dir, tracked, config);
        if (!files.length) throw new Error("Every tracked file is protected, generated, binary or too large, so there is no product code to change.");
        const pick = await pickFiles(model, ctx, files, more);
        spentThisRound.push(pick.costUsd);
        if (!pick.paths.length) return skip("nothing tried", "no files to change were picked");
        const shown = shownFiles(dir, pick.paths);
        if (!shown.length) return skip("nothing tried", "the picked files could not be read", pick.paths);
        const reply = await proposeEdits(model, ctx, shown);
        spentThisRound.push(reply.costUsd);
        const paths = shown.map((f) => f.path);
        if (!reply.proposal) return skip("nothing tried", "the model's reply was not usable", paths);
        const { summary, edits } = reply.proposal;
        if (!edits.length) return skip(summary, "no change proposed", paths);
        const checked = checkEdits(dir, edits, new Set(paths), config);
        if ("problem" in checked) return skip(summary, `edit refused: ${checked.problem}`, paths);
        const changed = checked.writes.map((w) => w.path);
        io.say(`Round ${n}: trying "${summary}" (${changed.join(", ")})`);
        for (const w of checked.writes) {
          mkdirSync(dirname(join(dir, w.path)), { recursive: true });
          writeFileSync(join(dir, w.path), w.text);
        }
        try {
          const commit = await commitPaths(io, dir, changed, `${summary}\n\nProposed by Synthe (npx synthe improve), round ${n}. Kept only if it measures better.\n`);
          return { summary, files: changed, commit };
        } catch (e) {
          return skip(summary, `the change could not be committed: ${firstLine(e)}`, changed);
        }
      });
      if ("miss" in proposed) { finish(proposed.miss); continue; }

      const m = await measureAt(io.exec, top, proposed.commit, config, io.say);
      const record: RoundRecord = { round: n, summary: proposed.summary, kept: false, value: m.measurement?.median ?? null, why: "", before, files: proposed.files, costUsd: sumCosts(spentThisRound), commit: proposed.commit };
      if (!m.measurement) record.why = `the metric gave no number: ${(m.reason ?? "no output").replace(/\.$/, "")}`;
      else {
        const why = notKeptWhy(config, best, m.measurement, m.guardPassed);
        if (why === null) { record.kept = true; record.why = "kept"; best = m.measurement; }
        else record.why = why;
      }
      finish(record);
    } catch (e) {
      // Credit used up, the proxy refusing, the API down, or git failing: keep what already won and stop here.
      const partial = sumCosts(spentThisRound);
      if (partial !== null) spent += partial;
      else partialUnknown = true;
      stopped = `Stopped in round ${n}: ${modelProblem(e) ?? firstLine(e)}`;
      break;
    }
  }
  return { best, rounds, spentUsd: spent, costKnown: !partialUnknown && rounds.every((r) => r.costUsd !== null), stopped, lessons };
}

export const LESSONS_FILE = ".synthe/improve-lessons.md";

export interface Published { branch: string; lessonsCommit: string; changedFiles: string[]; url?: string; merged?: boolean; problem?: string }

// The kept changes plus ONE commit that only writes lessons, on a new branch, pushed, with a pull request.
export async function publish(io: LoopIo, a: {
  top: string; start: string; base: string; branch: string; config: ImproveConfig; result: LoopResult;
  lessonsChoice: "claude" | "agents" | "none" | undefined; title: string; body: (lessonsCommit: string, diffstat: string, lessonsFiles: string[]) => string;
}): Promise<Published> {
  const { top, branch } = a;
  const lessons = await withScratch(io, top, a.result.best.commit, async (dir) => {
    appendLessons(dir, a.result.lessons);
    const files = [LESSONS_FILE];
    const target = lessonsTarget(dir, a.lessonsChoice);
    if (target) {
      const path = join(dir, target);
      writeFileSync(path, upsertLessonsBlock(existsSync(path) ? readFileSync(path, "utf8") : "", a.result.lessons));
      files.push(target);
    }
    // -f: a repo that ignores .synthe/ still gets the lessons this pull request is about.
    const sha = await commitPaths(io, dir, files, "Synthe: lessons from this improve run\n\nOnly adds what was measured in each round. No code changes.\n", true);
    return { sha, files };
  });
  await io.run("git", ["-C", top, "branch", branch, lessons.sha]);
  const changedFiles = (await io.run("git", ["-C", top, "diff", "--name-only", `${a.start}..${a.result.best.commit}`])).split("\n").filter(Boolean);
  const out: Published = { branch, lessonsCommit: lessons.sha, changedFiles };
  try {
    await io.run("git", ["-C", top, "push", "--quiet", "-u", "origin", branch]);
  } catch (e) {
    return { ...out, problem: `Synthe could not push ${branch} (${firstLine(e)}). The kept changes are on that local branch: check you can push to this repo, then run git push -u origin ${branch} and open the pull request on GitHub.` };
  }
  const diffstat = await io.run("git", ["-C", top, "diff", "--stat", `${a.start}..${a.result.best.commit}`]);
  try {
    const created = await io.run("gh", ["pr", "create", "--base", a.base, "--head", branch, "--title", a.title, "--body-file", "-"], a.body(lessons.sha, diffstat, lessons.files));
    out.url = created.trim().split("\n").at(-1)!.trim();
  } catch (e) {
    return { ...out, problem: `Synthe pushed ${branch} but could not open the pull request (${firstLine(e)}). Open it on GitHub against ${a.base}.` };
  }
  if (a.config.mode === "auto") {
    try {
      await io.run("gh", ["pr", "merge", out.url, "--squash", "--delete-branch"]);
      out.merged = true;
    } catch (e) {
      out.merged = false;
      out.problem = `Could not merge it (${firstLine(e)}): the pull request is open for a person to merge.`;
    }
  }
  return out;
}
