import type { Delimiter, Goal, PromptLocation } from "./goal.ts";

// The current prompt as it stands in the source file. Null means it can't be found, so nothing may change.
export function readPrompt(source: string, goal: Goal, tracked: string | null): string | null {
  if (goal.prompt.kind === "file") return source;
  const text = tracked ?? goal.prompt.initial;
  if (source.split(text).length === 2) return text;
  // The team edited the prompt since Synthe last saw it. Follow the edit when it's the only prompt-like string of the
  // same kind left in the file; with two or more, Synthe can't tell which one is the prompt.
  const { path, delimiter } = goal.prompt;
  const left = findPrompts([{ path, text: source }]).flatMap((f) => (f.location.kind === "inline" && f.location.delimiter === delimiter ? [f.location.initial] : []));
  return left.length === 1 && source.split(left[0]).length === 2 ? left[0] : null;
}

export function writePrompt(source: string, location: PromptLocation, current: string, next: string): string {
  if (location.kind === "file") return next;
  const [before, after] = source.split(current);
  return `${before}${next}${after}`;
}

const PROMPT_FILE = /(^|\/)[^/]*(prompt|system|instructions)[^/]*\.(md|txt)$/i;
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.git|venv|\.venv|__pycache__)\//;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py)$/;
const INLINE = /(system|prompt|instructions)\w*["']?\s*[:=]\s*(?:\w+\s*\(\s*)?(`{1}|"""|"|')([\s\S]*?)\2/gi;

export interface Found { location: PromptLocation; preview: string }

export function findPrompts(files: { path: string; text: string }[]): Found[] {
  const found: Found[] = [];
  for (const f of files) {
    if (SKIP_PATH.test(f.path)) continue;
    if (PROMPT_FILE.test(f.path) && f.text.trim()) {
      found.push({ location: { kind: "file", path: f.path }, preview: f.text.slice(0, 80) });
    } else if (CODE_FILE.test(f.path)) {
      for (const m of f.text.matchAll(INLINE)) {
        const text = m[3];
        if (text.length < 40 || text.includes("\\") || text.includes("${")) continue;
        found.push({ location: { kind: "inline", path: f.path, delimiter: m[2] as Delimiter, initial: text }, preview: text.slice(0, 80) });
      }
    }
  }
  return found;
}
