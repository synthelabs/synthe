// Glob matching for the problem file's `artifact` and `protect` lists. No dependency: the syntax we accept is
// small and fixed, so a hand-written translator to RegExp is easier to trust than a library's options.
//
// Syntax, on POSIX-style paths relative to the problem folder:
//   *      any characters inside one path segment
//   ?      one character inside one path segment
//   **     zero or more whole segments (only as a whole segment: "a/**/b", "**/x", "src/**")
//   [abc]  one character from the set; [!abc] or [^abc] negates; ranges like [a-z] work
//   {a,b}  either alternative; alternatives may hold other glob syntax and may nest
// A leading "./" is ignored. Dot files match like any other file: an artifact glob must not hide ".env.example".

import { readdirSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, RegExp>();

/** Normalize a relative path or glob: forward slashes, no leading "./", no doubled or trailing slashes. */
export function normalizePath(path: string): string {
  let out = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** A reason the glob is malformed, or null when it is usable. */
export function globProblem(glob: string): string | null {
  if (typeof glob !== "string" || glob.trim() === "") return "is empty";
  const g = normalizePath(glob);
  if (g.startsWith("/")) return "must be relative to the problem folder, not absolute";
  if (g.split("/").includes("..")) return "must not use '..' to leave the problem folder";
  let braces = 0;
  let inClass = false;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") inClass = true;
    else if (c === "{") braces++;
    else if (c === "}") { braces--; if (braces < 0) return "has a '}' with no '{'"; }
  }
  if (inClass) return "has a '[' with no ']'";
  if (braces > 0) return "has a '{' with no '}'";
  return null;
}

/** The RegExp for a glob. Throws on a malformed glob; call globProblem first to get a plain reason. */
export function globToRegExp(glob: string): RegExp {
  const key = normalizePath(glob);
  const hit = cache.get(key);
  if (hit) return hit;
  const problem = globProblem(key);
  if (problem) throw new Error(`glob "${glob}" ${problem}`);
  const re = new RegExp(`^${translate(key)}$`);
  cache.set(key, re);
  return re;
}

function translate(g: string): string {
  let out = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    const atSegStart = i === 0 || g[i - 1] === "/";
    if (c === "*" && g[i + 1] === "*" && atSegStart && (i + 2 === g.length || g[i + 2] === "/")) {
      if (i + 2 === g.length) {
        // Trailing "**": every path below this point, at any depth.
        out += ".*";
        i += 2;
      } else {
        // "**/": zero or more whole segments.
        out += "(?:[^/]*/)*";
        i += 3;
      }
      continue;
    }
    if (c === "*") { out += "[^/]*"; i++; continue; }
    if (c === "?") { out += "[^/]"; i++; continue; }
    if (c === "\\" && i + 1 < g.length) { out += escape(g[i + 1]); i += 2; continue; }
    if (c === "[") {
      const end = g.indexOf("]", i + 2);
      let body = g.slice(i + 1, end);
      let neg = false;
      if (body.startsWith("!") || body.startsWith("^")) { neg = true; body = body.slice(1); }
      body = body.replace(/[\\\]^]/g, (m) => `\\${m}`);
      out += neg ? `[^/${body}]` : `[${body}]`;
      i = end + 1;
      continue;
    }
    if (c === "{") {
      const end = matchingBrace(g, i);
      const parts = splitTopLevel(g.slice(i + 1, end));
      out += `(?:${parts.map(translate).join("|")})`;
      i = end + 1;
      continue;
    }
    out += escape(c);
    i++;
  }
  return out;
}

function matchingBrace(g: string, open: number): number {
  let depth = 0;
  for (let i = open; i < g.length; i++) {
    if (g[i] === "\\") { i++; continue; }
    if (g[i] === "{") depth++;
    else if (g[i] === "}" && --depth === 0) return i;
  }
  return g.length - 1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

function escape(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** True when the relative path matches the glob. */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

/** True when the relative path matches any of the globs. */
export function matchAny(globs: readonly string[], path: string): boolean {
  const p = normalizePath(path);
  return globs.some((g) => globToRegExp(g).test(p));
}

/** The first glob that matches the path, or undefined. Useful to name the rule in a refusal reason. */
export function firstMatch(globs: readonly string[], path: string): string | undefined {
  const p = normalizePath(path);
  return globs.find((g) => globToRegExp(g).test(p));
}

/**
 * Every file under root whose relative path matches an include glob and no exclude glob, sorted.
 * The ".git" folder is never walked. Symbolic links are not followed, so a link cannot pull outside files in.
 */
export function listMatching(root: string, include: readonly string[], exclude: readonly string[] = []): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), relPath);
      else if (e.isFile() && matchAny(include, relPath) && !matchAny(exclude, relPath)) found.push(relPath);
    }
  };
  walk(root, "");
  return found.sort();
}
