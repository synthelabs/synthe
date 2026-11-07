import packageJson from "../../package.json" with { type: "json" };
import type { ImproveConfig, Measurement } from "./config.ts";
import { plainNumber, type Verdict } from "./verdict.ts";

export function formatValue(value: number, unit: string): string {
  if (unit === "bytes") {
    if (Math.abs(value) < 1024) return `${plainNumber(value)} bytes`;
    if (Math.abs(value) < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  if (unit === "ms") return Math.abs(value) < 1000 ? `${plainNumber(value)} ms` : `${(value / 1000).toFixed(1)} s`;
  return `${plainNumber(value)} ${unit}`;
}

const runsText = (runs: number[]) => `${runs.length} ${runs.length === 1 ? "run" : "runs"}: ${runs.map(plainNumber).join(", ")}`;

export const modeText = (mode: ImproveConfig["mode"]) =>
  mode === "auto" ? "auto (a winning change merges into the default branch by itself)." : "review (a pull request waits for you).";

// What the coding agent works from: the number to beat, which way is better, and what it may not touch.
export function taskCard(config: ImproveConfig, branch: string): string {
  const { metric, baseline } = config;
  const listed = [...config.protect, ...(config.promptFiles ?? [])];
  const extra = listed.length ? `, and: ${listed.join(", ")}` : "";
  return [
    `Goal: ${config.goal}`,
    `Metric: ${metric.label}, ${metric.direction} is better. Current code: ${formatValue(baseline.median, metric.unit)} (${runsText(baseline.runs)}).`,
    `Regression check: ${config.guard.command ?? "none"}.`,
    `Do not change: tests, the metric command and its inputs, package.json and lockfiles, .github/, .synthe/${extra}.`,
    `Next: git checkout -b ${branch}; make ONE small change to product code; commit; npx synthe submit.`,
    `Mode: ${modeText(config.mode)}`,
  ].join("\n");
}

export const prTitle = (config: ImproveConfig, candidate: Measurement, base: Measurement = config.baseline) =>
  `Synthe: ${config.metric.label} ${formatValue(base.median, config.metric.unit)} → ${formatValue(candidate.median, config.metric.unit)}`;

export function prBody(a: { config: ImproveConfig; base: Measurement; candidate: Measurement; verdict: Verdict; baseSha: string; headSha: string; diffstat: string; guardCommand: string | null }): string {
  const { metric } = a.config;
  const f = (n: number) => formatValue(n, metric.unit);
  const moved = a.verdict.delta === 0 ? "unchanged" : `${a.verdict.delta > 0 ? "up" : "down"} by ${f(Math.abs(a.verdict.delta))}`;
  return [
    `Goal: ${a.config.goal}`,
    "",
    "## Result",
    "",
    `**${metric.label}: ${f(a.base.median)} → ${f(a.candidate.median)}** (${moved}; ${metric.direction} is better)`,
    "",
    `- Before: ${f(a.base.median)}, median of ${runsText(a.base.runs)}`,
    `- After: ${f(a.candidate.median)}, median of ${runsText(a.candidate.runs)}`,
    `- Run-to-run noise: ${f(a.verdict.noise)} (the larger spread of the two sets of runs)`,
    `- Regression check: ${a.guardCommand ? `\`${a.guardCommand}\` passed` : "none configured"}`,
    `- ${a.verdict.why}`,
    "",
    "## What changed",
    "",
    "```",
    a.diffstat.trimEnd(),
    "```",
    "",
    "## How it was measured",
    "",
    `- Metric: \`${metric.command}\` (${metric.runs} ${metric.runs === 1 ? "run" : "runs"} each, median)`,
    "- Before and after were each measured in a fresh checkout of its commit, with the same command.",
    `- Before: ${a.baseSha}`,
    `- After: ${a.headSha}`,
    `- synthe ${packageJson.version}`,
    "",
    "## Undo",
    "",
    a.config.mode === "auto"
      ? "This merges by itself. To undo it afterwards, run `git revert <merge commit>` on the default branch and push."
      : "Close this pull request. Nothing changes until someone merges it.",
    "",
    "Measured by Synthe. Numbers are from this machine; check them in your own environment too.",
  ].join("\n");
}
