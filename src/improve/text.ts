import type { ImproveConfig } from "./config.ts";
import { plainNumber } from "./verdict.ts";

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
  const extra = config.protect.length ? `, and: ${config.protect.join(", ")}` : "";
  return [
    `Goal: ${config.goal}`,
    `Metric: ${metric.label}, ${metric.direction} is better. Current code: ${formatValue(baseline.median, metric.unit)} (${runsText(baseline.runs)}).`,
    `Regression check: ${config.guard.command ?? "none"}.`,
    `Do not change: tests, the metric command and its inputs, package.json and lockfiles, .github/, .synthe/${extra}.`,
    `Next: git checkout -b ${branch}; make ONE small change to product code; commit; npx synthe submit.`,
    `Mode: ${modeText(config.mode)}`,
  ].join("\n");
}
