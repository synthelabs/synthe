import type { Goal } from "../core/goal.ts";
import type { RoundRecord, State } from "../core/state.ts";

// The score series and its renderings: how the team sees, in their chat and in the report issue, that
// their prompt got better. Everything here renders from what the rounds already recorded in state;
// nothing in this file measures anything, and an unmeasured round is never drawn as a measurement.

export interface ScorePoint { round: number; scorePct: number | null; merged: boolean }

// One point per round, in round order. A change counts as merged when the round's record says it
// landed; a proposal counts only once a person merges it, which is when settle() rewrites the
// record's outcome to "merged". Records written before scorePct existed have no score: null.
export function scoreSeries(state: State): ScorePoint[] {
  return state.rounds.map((r) => ({
    round: r.round,
    scorePct: typeof r.scorePct === "number" && Number.isFinite(r.scorePct) ? r.scorePct : null,
    merged: r.outcome === "merged",
  }));
}

// The series as it may be drawn: a round that wasn't measured inherits the last measured value,
// because the prompt provably didn't change between the two measurements, and is marked unmeasured
// so no surface mistakes it for a fresh reading. Points before the first measurement are dropped:
// there is nothing honest to draw for them.
export function displaySeries(points: ScorePoint[]): { round: number; pct: number; measured: boolean; merged: boolean }[] {
  const out: { round: number; pct: number; measured: boolean; merged: boolean }[] = [];
  let last: number | null = null;
  for (const p of points) {
    if (p.scorePct !== null) {
      last = p.scorePct;
      out.push({ round: p.round, pct: p.scorePct, measured: true, merged: p.merged });
    } else if (last !== null) {
      out.push({ round: p.round, pct: last, measured: false, merged: p.merged });
    }
  }
  return out;
}

const BLOCKS = "▁▂▃▄▅▆▇█";

// The series as one line of unicode blocks, for a chat or a terminal: 0 to 100 across the eight
// levels, so a flat series renders flat and a rise is visible at a glance.
export function sparkline(points: ScorePoint[]): string {
  return displaySeries(points)
    .map((p) => BLOCKS[Math.min(7, Math.max(0, Math.floor((p.pct / 100) * 8)))])
    .join("");
}

// Percentages as the team reads them: whole numbers stay whole, anything else keeps one decimal.
const fmtPct = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

// The same series as a small chart the report issue can embed. Deterministic string building, no
// dependencies. The y axis is always the full 0 to 100, every round is drawn, and the only text in
// the file is numbers, so nothing in it needs XML escaping. Filled circles are rounds where a change
// merged, rings are measured rounds that changed nothing, and small dots are rounds whose value is
// carried from the last measurement rather than measured themselves.
export function renderScoreSvg(points: ScorePoint[]): string {
  const disp = displaySeries(points);
  const W = 640, H = 180;
  const left = 36, right = 16, top = 24, bottom = 16;
  const pw = W - left - right, ph = H - top - bottom;
  const num = (v: number) => Math.round(v * 10) / 10;
  const x = (i: number) => (disp.length <= 1 ? left + pw / 2 : left + (i * pw) / (disp.length - 1));
  const y = (pct: number) => top + ((100 - pct) / 100) * ph;
  const ink = "#2f6feb", grid = "#d0d7de", faint = "#8b949e";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`,
    `<line x1="${left}" y1="${num(y(100))}" x2="${left + pw}" y2="${num(y(100))}" stroke="${grid}" stroke-width="1" stroke-dasharray="3 4"/>`,
    `<line x1="${left}" y1="${num(y(50))}" x2="${left + pw}" y2="${num(y(50))}" stroke="${grid}" stroke-width="1" stroke-dasharray="3 4"/>`,
    `<line x1="${left}" y1="${num(y(0))}" x2="${left + pw}" y2="${num(y(0))}" stroke="${grid}" stroke-width="1"/>`,
    `<text x="${left - 6}" y="${num(y(100) + 4)}" text-anchor="end" font-size="12" fill="${faint}">100</text>`,
    `<text x="${left - 6}" y="${num(y(50) + 4)}" text-anchor="end" font-size="12" fill="${faint}">50</text>`,
    `<text x="${left - 6}" y="${num(y(0) + 4)}" text-anchor="end" font-size="12" fill="${faint}">0</text>`,
  ];
  if (disp.length) {
    parts.push(`<polyline points="${disp.map((p, i) => `${num(x(i))},${num(y(p.pct))}`).join(" ")}" fill="none" stroke="${ink}" stroke-width="2"/>`);
    disp.forEach((p, i) => {
      if (!p.measured) parts.push(`<circle cx="${num(x(i))}" cy="${num(y(p.pct))}" r="2.5" fill="${faint}"/>`);
      else if (p.merged) parts.push(`<circle cx="${num(x(i))}" cy="${num(y(p.pct))}" r="4.5" fill="${ink}" stroke="${ink}"/>`);
      else parts.push(`<circle cx="${num(x(i))}" cy="${num(y(p.pct))}" r="4.5" fill="none" stroke="${ink}" stroke-width="2"/>`);
    });
    const label = (i: number) => {
      const p = disp[i];
      const ly = y(p.pct) < top + 16 ? y(p.pct) + 18 : y(p.pct) - 9;
      parts.push(`<text x="${num(x(i))}" y="${num(ly)}" text-anchor="middle" font-size="12" fill="${ink}">${fmtPct(p.pct)}%</text>`);
    };
    label(0);
    if (disp.length > 1) label(disp.length - 1);
  }
  parts.push("</svg>");
  return parts.join("\n");
}

const money = (r: RoundRecord) => (typeof r.costUsd === "number" ? ` · $${r.costUsd.toFixed(2)}` : "");

// One round of the delta block. The merged and no-change shapes are the contract the chat command
// and the guide rely on; the other outcomes get their own honest labels rather than being folded
// into "no change" when something else is true (a proposal is waiting, a person declined, a round
// didn't finish).
function roundLines(r: RoundRecord): string[] {
  if (r.outcome === "merged") {
    const lines = [`Round ${r.round} · merged${money(r)}`];
    if (r.changed) lines.push(`  What changed: ${r.changed}`);
    if (r.examplePair) {
      lines.push(`  Example, on: "${r.examplePair.input}"`);
      lines.push(`    Before: "${r.examplePair.beforeReply}"`);
      lines.push(`    After: "${r.examplePair.afterReply}"`);
      if (r.examplePair.improvedChecks.length) lines.push(`    Now passes: ${r.examplePair.improvedChecks.join(", ")}`);
    }
    if (typeof r.scorePct === "number") lines.push(`  Score this round: ${fmtPct(r.scorePct)}%`);
    return lines;
  }
  if (r.outcome === "proposed") return [`Round ${r.round} · proposed${money(r)}`, ...(r.plain ? [`  ${r.plain}`] : [])];
  if (r.outcome === "reverted") return [`Round ${r.round} · reverted${money(r)}`, ...(r.plain ? [`  ${r.plain}`] : [])];
  if (r.outcome === "declined") return [`Round ${r.round} · declined${money(r)}`, "  The change was closed without merging, so nothing changed."];
  if (r.outcome === "failed") return [`Round ${r.round} · didn't finish${money(r)}`, ...(r.plain ? [`  ${r.plain}`] : ["  The round didn't finish, so nothing changed."])];
  const lines = [`Round ${r.round} · no change${money(r)}`];
  if (r.tried?.length) lines.push(`  Tried ${r.tried.length} ${r.tried.length === 1 ? "change" : "changes"}, but none was clearly better, so nothing merged.`);
  else if (r.plain) lines.push(`  ${r.plain}`);
  else lines.push("  Nothing was clearly better, so nothing merged.");
  if (typeof r.scorePct === "number") lines.push(`  Score this round: ${fmtPct(r.scorePct)}%`);
  return lines;
}

// The delta block: the score's movement, the series in one line, and the latest rounds in plain
// words. Built to be pasted into a chat as written: short lines, no tables, no jargon. The headline
// appears only when at least one round was actually measured.
export function renderDeltaBlock(goal: Goal, state: State, maxRounds = 3): string {
  const series = scoreSeries(state);
  const measured = displaySeries(series).filter((p) => p.measured);
  const lines: string[] = [];
  if (measured.length === 1) {
    lines.push(`Your prompt scores ${fmtPct(measured[0].pct)}% (checks passed on test cases Synthe never trains on)`);
    lines.push(`Score by round: ${sparkline(series)}`);
  } else if (measured.length > 1) {
    lines.push(`Your prompt: ${fmtPct(measured[0].pct)}% → ${fmtPct(measured.at(-1)!.pct)}% (checks passed on test cases Synthe never trains on)`);
    lines.push(`Score by round: ${sparkline(series)}`);
  }
  for (const r of state.rounds.slice(-Math.max(0, maxRounds)).reverse()) lines.push(...roundLines(r));
  return lines.join("\n");
}
