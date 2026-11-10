import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatValue } from "./text.ts";

export interface RoundLesson { round: number; kept: boolean; summary: string; before: number; after: number | null; unit: string; why?: string }

const LINE_MAX = 240;
const WHY_MAX = 120;
const BLOCK_MAX = 12;
const START = "<!-- synthe:lessons:start -->";
const END = "<!-- synthe:lessons:end -->";
const INTRO = "Measured by Synthe in this repo (newest last). Keep or delete freely; Synthe rewrites only this block.";
const CODE_WINS = "If this conflicts with the code, the code wins.";
const HEADER = "# What Synthe measured in this repo\n\nWritten by `npx synthe improve`: one line per round, newest last, each from a measurement.\n";

// Model text can hold newlines, and a stray comment opener could fake our block markers.
const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/<!--/g, "<!- -").trim();
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

export function lessonLine(l: RoundLesson): string {
  const head = `Round ${l.round} ${l.kept ? "kept" : "not kept"}: `;
  const why = clip(oneLine(l.why ?? ""), WHY_MAX).replace(/[.\s]+$/, "");
  const numbers = l.after === null ? "" : `${formatValue(l.before, l.unit)} → ${formatValue(l.after, l.unit)}`;
  const detail = [why, numbers].filter(Boolean).join("; ");
  const tail = `${detail ? ` (${detail})` : ""}.`;
  // Shorten the summary, not the numbers: they are the part that came from a measurement.
  const summary = clip(oneLine(l.summary).replace(/[.\s]+$/, ""), Math.max(20, LINE_MAX - head.length - tail.length));
  return clip(`${head}${summary}${tail}`, LINE_MAX);
}

const lessonsFile = (gitRoot: string) => join(gitRoot, ".synthe", "improve-lessons.md");

// gitRoot may be the repo root or a git dir like /repo/.git (the untracked local log); both just get a .synthe folder.
export function appendLessons(gitRoot: string, lines: string[]): void {
  const clean = lines.map((l) => oneLine(l).replace(/^- /, "")).filter(Boolean);
  if (!clean.length) return;
  const file = lessonsFile(gitRoot);
  mkdirSync(join(gitRoot, ".synthe"), { recursive: true });
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { /* first lesson: start the file */ }
  const lead = !text ? `${HEADER}\n` : text.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${lead}${clean.map((l) => `- ${l}\n`).join("")}`);
}

export function readLessons(gitRoot: string, max = 20): string[] {
  let text: string;
  try { text = readFileSync(lessonsFile(gitRoot), "utf8"); } catch { return []; }
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
  return max > 0 ? lines.slice(-max) : [];
}

export function upsertLessonsBlock(fileText: string, lines: string[]): string {
  const eol = fileText.includes("\r\n") ? "\r\n" : "\n";
  const bullets = lines.map((l) => oneLine(l).replace(/^- /, "")).filter(Boolean).slice(-BLOCK_MAX).map((l) => `- ${l}`);
  const block = [START, INTRO, CODE_WINS, ...bullets, END].join(eol);

  // Replace the first complete block and drop any further ones, so there is never more than one.
  const MARK = "\u0000synthe-block\u0000";
  let found = false;
  let text = fileText.replace(new RegExp(`${START}[\\s\\S]*?${END}(\\r?\\n)?`, "g"), (_m, nl: string | undefined) => {
    if (found) return "";
    found = true;
    return MARK + (nl ?? "");
  });
  // A marker with no partner means someone edited by hand. Remove the marker only; their text stays.
  text = text.replace(/^[ \t]*<!-- synthe:lessons:(?:start|end) -->[ \t]*(?:\r?\n|$)/gm, "").replace(/<!-- synthe:lessons:(?:start|end) -->/g, "");
  if (found) return text.replace(MARK, () => block);

  if (!text) return block + eol;
  return `${text}${text.endsWith("\n") ? "" : eol}${eol}${block}${eol}`;
}

// Returns a path relative to gitRoot (CLAUDE.md or AGENTS.md); the caller joins it. Writing into files the team owns is opt-in:
// only an explicit choice names one (even if it doesn't exist yet). Unset means no write, whatever files are there, because
// LLM-written context files did worse than developer-written ones (Gloaguen et al., arXiv 2602.11988).
export function lessonsTarget(_gitRoot: string, choice: "claude" | "agents" | "none" | undefined): string | null {
  if (choice === "claude") return "CLAUDE.md";
  if (choice === "agents") return "AGENTS.md";
  return null;
}
