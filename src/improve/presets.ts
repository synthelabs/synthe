import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { COMMAND_TIMEOUT_MS, type Direction, type ImproveConfig, type PresetId } from "./config.ts";
import type { Exec } from "./exec.ts";

export interface Preset { id: PresetId; label: string; unit: string; direction: Direction; runs: number; command: string; guard: string | null }

const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

// Only what this repo can run. Custom is always offered, last.
export function detectPresets(files: { path: string; text: string }[]): Preset[] {
  let scripts: Record<string, unknown> = {};
  const pkg = files.find((f) => f.path === "package.json");
  if (pkg) {
    try { scripts = JSON.parse(pkg.text)?.scripts ?? {}; } catch { /* an unreadable package.json offers only custom */ }
  }
  const hasTest = typeof scripts.test === "string" && scripts.test.trim() !== "" && scripts.test.trim() !== NPM_PLACEHOLDER;
  const hasBuild = typeof scripts.build === "string" && scripts.build.trim() !== "";
  const guard = hasTest ? "npm test" : null;
  const presets: Preset[] = [];
  if (hasTest) presets.push({ id: "test-pass", label: "tests passing", unit: "tests", direction: "higher", runs: 1, command: "npm test", guard: null });
  if (hasBuild) {
    presets.push({ id: "bundle-size", label: "built JS and CSS, gzipped", unit: "bytes", direction: "lower", runs: 1, command: "npm run build", guard });
    presets.push({ id: "build-time", label: "build time", unit: "ms", direction: "lower", runs: 3, command: "npm run build", guard });
  }
  presets.push({ id: "custom", label: "your own command", unit: "units", direction: "higher", runs: 3, command: "", guard });
  return presets;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

// The last line that is only a number, so `npm run`'s "> app@1.0.0 metric" banner lines don't count.
export function lastNumber(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => NUMBER.test(l));
  if (!lines.length) return null;
  const n = Number(lines.at(-1));
  return Number.isFinite(n) ? n : null;
}

const lastMatch = (text: string, re: RegExp) => {
  const all = [...text.matchAll(re)];
  return all.length ? Number(all.at(-1)![1]) : null;
};

// Passing tests from the summary line of node:test, jest/vitest, mocha or pytest.
export function countPassed(output: string): number | null {
  return lastMatch(output, /^\s*[ℹ#] pass (\d+)\s*$/gm)
    ?? lastMatch(output, /^\s*Tests:?\s.*?(\d+) passed/gm)
    ?? lastMatch(output, /^\s*(\d+) passing\b/gm)
    ?? lastMatch(output, /^=+ .*?\b(\d+) passed\b.*=+\s*$/gm);
}

const OUTPUT_DIRS = ["dist", "build", "out", ".next/static", "public/build"];

function builtFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : builtFiles(path);
    return e.isFile() && /\.(m?js|css)$/.test(e.name) ? [path] : [];
  });
}

// Gzipped bytes of the built JS and CSS: roughly what a visitor downloads.
export function bundleBytes(root: string): number | null {
  const dir = OUTPUT_DIRS.map((d) => join(root, d)).find((d) => existsSync(d) && statSync(d).isDirectory());
  if (!dir) return null;
  const files = builtFiles(dir);
  if (!files.length) return null;
  return files.reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0);
}

export const REASONS = {
  noNumber: "The metric command printed no number.",
  failed: "The metric command failed (exit code not 0).",
  timedOut: "The metric command took longer than 10 minutes.",
  noTests: "No tests were counted in the output.",
  noBuild: "No built JS or CSS was found under dist, build, out, .next/static or public/build.",
};

export async function measureOnce(exec: Exec, cwd: string, config: ImproveConfig): Promise<{ value: number | null; ms: number; reason?: string }> {
  const r = await exec(cwd, config.metric.command, COMMAND_TIMEOUT_MS);
  const none = (reason: string) => ({ value: null, ms: r.ms, reason });
  if (r.timedOut) return none(REASONS.timedOut);
  switch (config.metric.preset) {
    case "test-pass": {
      // Failing tests exit non-zero but still count: fewer passing is a lower number, not a broken measurement.
      const n = countPassed(`${r.stdout}\n${r.stderr}`);
      return n === null ? none(REASONS.noTests) : { value: n, ms: r.ms };
    }
    case "bundle-size": {
      if (!r.ok) return none(REASONS.failed);
      const n = bundleBytes(cwd);
      return n === null ? none(REASONS.noBuild) : { value: n, ms: r.ms };
    }
    case "build-time":
      return r.ok ? { value: r.ms, ms: r.ms } : none(REASONS.failed);
    default: {
      if (!r.ok) return none(REASONS.failed);
      const n = lastNumber(r.stdout);
      return n === null ? none(REASONS.noNumber) : { value: n, ms: r.ms };
    }
  }
}
