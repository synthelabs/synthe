import { join } from "node:path";

// Inside .git: never tracked, never dirty, one per clone. The candidate commit can't carry an edited copy.
export const improveFile = (gitDir: string) => join(gitDir, "synthe-improve.json");

export type Direction = "higher" | "lower";
export type PresetId = "test-pass" | "pytest" | "bundle-size" | "build-time" | "custom";
// `failing`: for metrics that count passing tests, every test that failed in any run (null when the output did not
// name them); absent for every other metric, and in configs written before this field existed.
export interface Measurement { commit: string; median: number; runs: number[]; at: string; failing?: string[] | null }
export interface ImproveConfig {
  version: 1;
  goal: string;
  metric: { preset: PresetId; label: string; unit: string; command: string; direction: Direction; runs: number };
  guard: { command: string | null };
  protect: string[];
  // Files prompt mode tunes (named in synthe.json); kept apart from `protect` so a refusal names the real reason.
  promptFiles?: string[];
  // Files only the metric or the regression check imports (see metricOnlyFiles in protect.ts); protected like the script.
  metricOnly?: string[];
  mode: "auto" | "review";
  baseline: Measurement;
}

export const DEFAULT_RUNS = 3;
export const COMMAND_TIMEOUT_MS = 600_000;
const PRESETS: PresetId[] = ["test-pass", "pytest", "bundle-size", "build-time", "custom"];

const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;

export function parseImproveConfig(raw: string): ImproveConfig {
  const bad = (why: string): never => { throw new Error(`synthe improve config: ${why}`); };
  let c: any;
  try { c = JSON.parse(raw); } catch { bad("not valid JSON. Run npx synthe improve again."); }
  if (c?.version !== 1) bad("version must be 1");
  if (!text(c.goal)) bad("goal is required");
  const m = c.metric;
  if (!m || typeof m !== "object") bad("metric is required");
  if (!PRESETS.includes(m.preset)) bad(`metric.preset must be one of ${PRESETS.join(", ")}`);
  if (!text(m.label)) bad("metric.label is required");
  if (!text(m.unit)) bad("metric.unit is required");
  if (!text(m.command)) bad("metric.command is required");
  if (m.direction !== "higher" && m.direction !== "lower") bad("metric.direction must be higher or lower");
  if (!Number.isInteger(m.runs) || m.runs < 1 || m.runs > 10) bad("metric.runs must be a whole number from 1 to 10");
  if (!c.guard || typeof c.guard !== "object" || (c.guard.command !== null && !text(c.guard.command))) bad("guard.command must be a command or null");
  if (!Array.isArray(c.protect) || c.protect.some((p: unknown) => !text(p))) bad("protect must be a list of paths");
  // Same rule as promptPathProblem in src/core/safety.ts: a path that leaves the repo protects nothing in it.
  if (c.protect.some((p: string) => p.startsWith("/") || p.split("/").includes(".."))) bad("protect paths must stay inside the repo");
  if (c.promptFiles !== undefined) {
    if (!Array.isArray(c.promptFiles) || c.promptFiles.some((p: unknown) => !text(p))) bad("promptFiles must be a list of paths");
    if (c.promptFiles.some((p: string) => p.startsWith("/") || p.split("/").includes(".."))) bad("promptFiles paths must stay inside the repo");
  }
  if (c.metricOnly !== undefined) {
    if (!Array.isArray(c.metricOnly) || c.metricOnly.some((p: unknown) => !text(p))) bad("metricOnly must be a list of paths");
    if (c.metricOnly.some((p: string) => p.startsWith("/") || p.split("/").includes(".."))) bad("metricOnly paths must stay inside the repo");
  }
  if (c.mode !== "auto" && c.mode !== "review") bad("mode must be auto or review");
  const b = c.baseline;
  if (!b || typeof b !== "object") bad("baseline is required");
  if (!text(b.commit)) bad("baseline.commit is required");
  if (!Array.isArray(b.runs) || !b.runs.length || b.runs.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) bad("baseline.runs must list at least one number");
  if (typeof b.median !== "number" || !Number.isFinite(b.median)) bad("baseline.median must be a number");
  if (typeof b.at !== "string") bad("baseline.at is required");
  if (b.failing !== undefined && b.failing !== null && (!Array.isArray(b.failing) || b.failing.some((t: unknown) => typeof t !== "string"))) bad("baseline.failing must be a list of test names or null");
  return c as ImproveConfig;
}
