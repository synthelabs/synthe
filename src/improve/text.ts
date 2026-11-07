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

type Metric = ImproveConfig["metric"];

// The label reads as the unit when the unit is the "units" placeholder (what Enter gives at the unit question) or
// the label already names it: "3 valid signups", "5 tests passing". Otherwise both are shown: "build time 3.4 s".
const labelIsUnit = (m: Pick<Metric, "label" | "unit">) =>
  m.unit === "units" || (m.unit !== "bytes" && m.unit !== "ms" && m.label.toLowerCase().includes(m.unit.toLowerCase()));
const bare = (n: number, metric: Pick<Metric, "label" | "unit">) => (labelIsUnit(metric) ? plainNumber(n) : formatValue(n, metric.unit));

export const quantity = (n: number, metric: Pick<Metric, "label" | "unit">) =>
  labelIsUnit(metric) ? `${plainNumber(n)} ${metric.label}` : `${metric.label} ${formatValue(n, metric.unit)}`;

export const movement = (before: number, after: number, metric: Pick<Metric, "label" | "unit">) =>
  labelIsUnit(metric) ? `${plainNumber(before)} → ${plainNumber(after)} ${metric.label}` : `${metric.label} ${bare(before, metric)} → ${bare(after, metric)}`;

export const money = (usd: number) => (usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);

export const baselineLine = (config: ImproveConfig) =>
  `Current code: ${quantity(config.baseline.median, config.metric)} (runs: ${config.baseline.runs.map(plainNumber).join(", ")})`;

// One round of the improve loop, as the pull request and the closing summary show it.
export interface RoundRow { round: number; summary: string; kept: boolean; value: number | null; why: string; costUsd: number | null }

const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

export function roundsTable(rows: RoundRow[], metric: Metric): string {
  return [
    "| Round | Change | Value | Result | Cost |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.round} | ${cell(r.summary)} | ${r.value === null ? "not measured" : bare(r.value, metric)} | ${r.kept ? "**kept**" : cell(`not kept: ${r.why}`)} | ${r.costUsd === null ? "unknown" : money(r.costUsd)} |`),
  ].join("\n");
}

export const loopPrTitle = (config: ImproveConfig, best: Measurement) =>
  `Synthe: ${config.metric.label} ${bare(config.baseline.median, config.metric)} → ${bare(best.median, config.metric)}`;

export function loopPrBody(a: {
  config: ImproveConfig; best: Measurement; rows: RoundRow[]; spentUsd: number; costKnown: boolean; stopped: string;
  base: string; lessonsCommit: string; lessonsFiles: string[]; diffstat: string; model: string;
}): string {
  const { metric, guard, baseline } = a.config;
  const kept = a.rows.filter((r) => r.kept).length;
  const lessonsWhere = a.lessonsFiles.map((f) => (f.endsWith("improve-lessons.md") ? `\`${f}\`` : `the Synthe lessons block in \`${f}\``)).join(" and ");
  return [
    `Goal: ${a.config.goal}`,
    "",
    "## Result",
    "",
    `**${metric.label}: ${bare(baseline.median, metric)} → ${bare(a.best.median, metric)}** (${metric.direction} is better). Synthe ran ${a.rows.length} ${a.rows.length === 1 ? "round" : "rounds"} and kept ${kept} ${kept === 1 ? "change" : "changes"}; each kept change builds on the one before.`,
    "",
    `- Before: ${quantity(baseline.median, metric)}, median of ${runsText(baseline.runs)}`,
    `- After: ${quantity(a.best.median, metric)}, median of ${runsText(a.best.runs)}`,
    `- Regression check: ${guard.command ? `\`${guard.command}\` passed on every kept change` : "none configured"}`,
    `- Model cost: ${a.costKnown ? money(a.spentUsd) : `at least ${money(a.spentUsd)} (some rounds' cost is unknown)`}`,
    `- ${a.stopped}`,
    "",
    "## Rounds",
    "",
    roundsTable(a.rows, metric),
    "",
    "## What changed",
    "",
    "```",
    a.diffstat.trimEnd(),
    "```",
    "",
    "## How it was measured",
    "",
    `- Metric: \`${metric.command}\` (${metric.runs} ${metric.runs === 1 ? "run" : "runs"} each, median).`,
    `- Regression check: ${guard.command ? `\`${guard.command}\`, run once on every change` : "none"}.`,
    "- Each change was committed and measured in a fresh checkout of its commit, with the same command. It was kept only when it beat the best so far by more than the run-to-run noise and the regression check passed. Everything else was thrown away.",
    "- Synthe could not change tests, the metric or its data, dependencies, config, CI or its own files: such edits are refused before anything runs.",
    `- Started from: ${baseline.commit} (${a.base})`,
    `- Best: ${a.best.commit}`,
    `- Changes written by ${a.model}; synthe ${packageJson.version}.`,
    "",
    "## The last commit only adds lessons",
    "",
    `The last commit (${a.lessonsCommit}) writes ${lessonsWhere}: one line per round, from the numbers above. It changes no code.`,
    "",
    "## Undo",
    "",
    a.config.mode === "auto"
      ? `This merges by itself. To undo it afterwards, run \`git revert <merge commit>\` on ${a.base} and push.`
      : "Close this pull request. Nothing changes until someone merges it.",
    "",
    "Measured by Synthe. Numbers are from this machine; check them in your own environment too.",
  ].join("\n");
}

export const triedLines = (rows: RoundRow[]) => rows.map((r) => `- Round ${r.round}: ${r.summary}. Not kept: ${r.why}.`);
