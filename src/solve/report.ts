import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt, SolveResult } from "./types.ts";

// The two files a solve run leaves behind: result.json for tools, report.md for people. The shape of result.json
// is the contract in swarm/GOAL.md; extra fields are allowed after the required ones.

export interface ReportExtras {
  goal?: string;
  unit?: string;
  direction?: "higher" | "lower";
}

// Returns the two paths it wrote.
export function writeReport(outDir: string, result: SolveResult, extras: ReportExtras = {}): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, "result.json");
  const md = join(outDir, "report.md");
  const ordered: SolveResult = {
    problem: result.problem,
    stopped: result.stopped,
    baseline: result.baseline,
    final: result.final,
    branch: result.branch,
    attempts: result.attempts.map((a): Attempt => ({ round: a.round, summary: a.summary, kept: a.kept, reason: a.reason, ...(a.before === undefined ? {} : { before: a.before }), ...(a.after === undefined ? {} : { after: a.after }) })),
    ...(result.cost ? { cost: result.cost } : {}),
  };
  writeFileSync(json, JSON.stringify(ordered, null, 2) + "\n");
  writeFileSync(md, renderReport(ordered, extras));
  return { json, md };
}

export function formatNumber(n: number | null | undefined, unit?: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const rounded = Math.abs(n) >= 100 ? n.toFixed(1) : Number(n.toPrecision(4)).toString();
  return unit ? `${rounded} ${unit}` : rounded;
}

// One line, safe inside a Markdown table cell.
function cell(text: string): string {
  return text.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim() || "-";
}

export function renderReport(r: SolveResult, extras: ReportExtras = {}): string {
  const u = extras.unit;
  const kept = r.attempts.filter((a) => a.kept);
  const lines: string[] = [`# Synthe solve: ${r.problem}`, ""];
  if (extras.goal) lines.push(`Goal: ${extras.goal}`, "");

  const better = extras.direction === "lower" ? "lower is better" : extras.direction === "higher" ? "higher is better" : "";
  lines.push(`- Baseline: ${formatNumber(r.baseline, u)}${better ? ` (${better})` : ""}`);
  lines.push(`- Final: ${formatNumber(r.final, u)}`);
  lines.push(`- Attempts: ${r.attempts.length}, kept: ${kept.length}`);
  lines.push(`- Stopped: ${r.stopped}`);
  if (r.cost && r.cost.calls > 0) {
    const usd = r.cost.usd === null ? "cost unknown (set model.prices to see it)" : `${r.cost.usd.toFixed(4)} US dollars`;
    lines.push(`- Model calls: ${r.cost.calls} (${r.cost.input_tokens} input tokens, ${r.cost.output_tokens} output tokens), ${usd}`);
  }
  lines.push(r.branch
    ? `- Kept changes are on branch \`${r.branch}\`. Your working tree and current branch did not change.`
    : "- No change was kept, so Synthe made no branch. Your working tree and current branch did not change.");
  lines.push("");

  if (r.attempts.length) {
    lines.push("## Attempts", "", "| Round | Change | Kept | Before | After | Reason |", "|---|---|---|---|---|---|");
    for (const a of r.attempts) {
      lines.push(`| ${a.round} | ${cell(a.summary)} | ${a.kept ? "kept" : "not kept"} | ${formatNumber(a.before, u)} | ${formatNumber(a.after, u)} | ${cell(a.reason)} |`);
    }
    lines.push("");
  } else {
    lines.push("No attempts were made.", "");
  }

  lines.push("## Next step", "");
  if (r.branch) lines.push(`Read the diff with \`git diff HEAD...${r.branch}\`. If you agree with it, merge the branch.`);
  else lines.push("Read the reasons above. Then change the goal, the measure or the proposer, and run `synthe solve` again.");
  lines.push("");
  return lines.join("\n");
}
