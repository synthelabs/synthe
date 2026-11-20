import type { ScoreRow } from "../core/merge-rule.ts";

// Judges tend to prefer longer, more elaborate replies. The scorer records the full length of both replies in every
// duel, and this module turns those lengths into the one line the team sees. It only displays: it never blocks a merge.
export const LENGTH_WARN = 0.3; // median reply growth above this (30%) gets a warning
export const GUARD_EXAMPLE = "Answers the question without padding";
// The rule given to the judge, in the scoring prompt and in `calibrate --judge`, so both measure the same judge.
export const NO_LENGTH_PREFERENCE = "Don't prefer a reply because it is longer or more elaborate; prefer it only when it meets the goal better.";

export interface LengthShift { before: number; after: number }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// The median length, in characters, of the current prompt's replies and of a candidate's replies to the same training
// cases. rows are the candidate's training rows: each carries the length of its own reply (chars) and of the current
// prompt's reply it was judged against (currentChars). Null when no case has both, so an unmeasured round never
// shows a number.
export function lengthShift(rows: ScoreRow[] | undefined): LengthShift | null {
  const pairs = (rows ?? []).filter((r) => Number.isSafeInteger(r.chars) && Number.isSafeInteger(r.currentChars) && r.chars! >= 0 && r.currentChars! >= 0);
  if (pairs.length === 0) return null;
  return { before: median(pairs.map((r) => r.currentChars!)), after: median(pairs.map((r) => r.chars!)) };
}

const growth = (s: LengthShift) => (s.before > 0 ? (s.after - s.before) / s.before : null);
export const lengthGrewTooMuch = (s: LengthShift) => { const g = growth(s); return g !== null && g > LENGTH_WARN; };

// "Replies got 42% longer (median 610 → 866 characters)." The warning follows only above LENGTH_WARN.
export function lengthSentence(s: LengthShift): string {
  const g = growth(s);
  const span = `median ${s.before} → ${s.after} characters`;
  if (g === null) return `Replies are now a median of ${s.after} characters.`;
  const pct = Math.round(Math.abs(g) * 100);
  return pct === 0 ? `Replies stayed about the same length (${span}).` : `Replies got ${pct}% ${g > 0 ? "longer" : "shorter"} (${span}).`;
}

export function lengthWarning(s: LengthShift): string | null {
  return lengthGrewTooMuch(s)
    ? `Warning: AI judges tend to prefer longer replies, so this change may be winning on length rather than quality. Read the example replies, and if they are padded, add a guard such as "${GUARD_EXAMPLE}" to \`counter_checks\` in \`synthe.json\`.`
    : null;
}

export function lengthLines(s: LengthShift | null | undefined): string[] {
  if (!s) return [];
  const warning = lengthWarning(s);
  return [lengthSentence(s), ...(warning ? [warning] : [])];
}
