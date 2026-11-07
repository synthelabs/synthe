import { existsSync, readFileSync } from "node:fs";
import { AgentSetupError, askPerson } from "./agent.ts";
import { preflight, type ImproveIo } from "./improve.ts";
import { improveFile, parseImproveConfig, type ImproveConfig, type Measurement } from "../improve/config.ts";
import { protectedChanges } from "../improve/protect.ts";
import { formatValue, prBody, prTitle } from "../improve/text.ts";
import { verdict } from "../improve/verdict.ts";
import { measureAt, type MeasureResult } from "../improve/worktree.ts";

export const SUBMIT_NEXT_WIN = "NEXT: Show the person the result and the pull request link as written.";
export const SUBMIT_NEXT_LOSS = "NEXT: Show the person why this change did not win, as written. If they want another try, make a different small change on the same branch, commit, and run `npx synthe submit` again.";
// One small change at a time keeps the measured difference attributable to the change.
export const MAX_CHANGED_FILES = 60;

export function submitOptions(args: string[]): { agent: boolean } {
  const agent = args.includes("--agent");
  for (const [i, flag] of args.entries()) {
    if (flag !== "--agent" || args.indexOf(flag) !== i) {
      if (agent) askPerson(flag);
      throw new AgentSetupError(`${flag} is not an option of npx synthe submit. Run it with no options, or with --agent from a coding agent.`);
    }
  }
  return { agent };
}

const firstLine = (e: unknown) => ((e as Error).message ?? String(e)).trim().split("\n")[0];

export async function submit(io: ImproveIo, _root: string, options: { agent: boolean }): Promise<boolean> {
  const { problems, repo } = await preflight(io, "Commit your change first.");
  if (!repo) {
    io.say("Synthe can't measure this yet. Fix these, then run npx synthe submit again:");
    for (const p of problems) io.say(`- ${p}`);
    return false;
  }
  const def = repo.defaultBranch;
  const branch = (await io.run("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch === "HEAD" || branch === def) {
    io.say("Make your change on a branch: git checkout -b synthe/improve-1, then run npx synthe submit again.");
    return false;
  }
  const file = improveFile(repo.gitDir);
  if (!existsSync(file)) {
    io.say("Run npx synthe improve first. It measures the current code and saves what to compare against.");
    return false;
  }
  let config: ImproveConfig;
  try {
    config = parseImproveConfig(readFileSync(file, "utf8"));
  } catch (e) {
    io.say(`${(e as Error).message}. Run npx synthe improve again.`);
    return false;
  }

  // Compare against what the pull request will merge into: the default branch as GitHub has it, when known.
  try { await io.run("git", ["fetch", "--quiet", "origin", def]); } catch { /* offline: use what this clone has */ }
  let target = def;
  try { await io.run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${def}`]); target = `origin/${def}`; } catch { /* no remote copy */ }
  let base: string;
  try {
    base = (await io.run("git", ["merge-base", target, "HEAD"])).trim();
  } catch {
    io.say(`This branch shares no history with ${def}. Start it from ${def}: git checkout ${def} && git checkout -b synthe/improve-1.`);
    return false;
  }
  const changed = (await io.run("git", ["diff", "--name-only", `${base}..HEAD`])).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!changed.length) {
    io.say("No committed change to measure. Make ONE small change to product code, commit it, then run npx synthe submit again.");
    return false;
  }
  const refused = protectedChanges(changed, config);
  if (refused.length) {
    for (const r of refused) io.say(r);
    io.say("Nothing was measured. Undo those edits and run npx synthe submit again.");
    return false;
  }
  if (changed.length > MAX_CHANGED_FILES) {
    io.say(`This change touches ${changed.length} files. Synthe measures one small change at a time; split it up.`);
    return false;
  }

  let baseline: Measurement = config.baseline;
  let candidate: MeasureResult;
  try {
    if (config.baseline.commit !== base) {
      io.say(`The default branch moved since you ran improve; measuring it again at ${base.slice(0, 7)}...`);
      const again = await measureAt(io.exec, repo.top, base, config, io.say);
      if (!again.measurement || again.guardPassed === false) {
        const why = again.measurement ? `the regression check (${config.guard.command}) fails on it` : again.reason ?? "no number";
        io.say(`The current code no longer measures cleanly (${why}). Run npx synthe improve again.`);
        return false;
      }
      baseline = again.measurement;
    }
    candidate = await measureAt(io.exec, repo.top, repo.head, config, io.say);
  } catch (e) {
    io.say(`${firstLine(e)} Nothing was opened.`);
    return false;
  }
  if (!candidate.measurement) {
    io.say(`${candidate.reason ?? "The metric gave no number."} Nothing was opened. Fix it on this branch, commit, and run npx synthe submit again.`);
    return false;
  }

  const f = (n: number) => formatValue(n, config.metric.unit);
  const v = verdict(config.metric.direction, baseline, candidate.measurement, candidate.guardPassed);
  io.say(`${config.metric.label}: ${f(baseline.median)} → ${f(candidate.measurement.median)} (${config.metric.direction} is better).`);
  if (!v.win) {
    io.say(`Not merged: ${v.why}`);
    io.say(`Your branch ${branch} is unchanged; nothing was pushed.`);
    if (options.agent) io.say(SUBMIT_NEXT_LOSS);
    return false;
  }

  try {
    await io.run("git", ["push", "-u", "origin", "HEAD"]);
  } catch (e) {
    io.say(`It won, but Synthe could not push ${branch} (${firstLine(e)}). Nothing was opened. Check you can push to this repo, then run npx synthe submit again.`);
    return false;
  }
  const diffstat = await io.run("git", ["diff", "--stat", `${base}..HEAD`]);
  const body = prBody({ config, base: baseline, candidate: candidate.measurement, verdict: v, baseSha: base, headSha: repo.head, diffstat, guardCommand: config.guard.command });
  let url: string;
  try {
    const out = await io.run("gh", ["pr", "create", "--base", def, "--head", branch, "--title", prTitle(config, candidate.measurement, baseline), "--body-file", "-"], body);
    url = out.trim().split("\n").at(-1)!.trim();
  } catch (e) {
    io.say(`It won, but Synthe could not open the pull request (${firstLine(e)}). ${branch} is pushed; open the pull request on GitHub.`);
    return false;
  }
  io.say(`Pull request: ${url}`);
  io.say(v.why);
  if (config.mode === "auto") {
    try {
      await io.run("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
      io.say(`Merged into ${def}. Run git pull.`);
    } catch (e) {
      io.say(`Could not merge it (${firstLine(e)}): the pull request is open for a person to merge.`);
    }
  } else {
    io.say("Review it there; merge it to keep the change.");
  }
  if (options.agent) io.say(SUBMIT_NEXT_WIN);
  return true;
}
