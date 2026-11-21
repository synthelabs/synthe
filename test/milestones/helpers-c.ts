// Shared helpers for the milestone checks P09, P14, P15, P16 and FINAL. They use only Node built-ins and import
// nothing from src/: the checks call the CLI as a black box, as swarm/GOAL.md says.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = join(ROOT, "src/cli/main.ts");
export const ZOO = join(ROOT, "swarm/zoo");

export interface Ran { code: number | null; stdout: string; stderr: string; timedOut: boolean }

// Runs a command without a shell. On timeout, the whole process group is killed, so no child keeps running.
export function run(cmd: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, o.timeoutMs ?? 60_000);
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}

// `node src/cli/main.ts <args>`, the way every check calls Synthe.
export const synthe = (args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => run(process.execPath, [CLI, ...args], o);

export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `synthe-ms-${prefix}-`));

// An environment with a private home folder and no keys or Synthe settings from the person who runs the checks.
// So memory that Synthe keeps outside the repository cannot leak from one run to the next.
export function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SYNTHE_|ANTHROPIC_|OPENAI_|GIT_|XDG_|NODE_TEST)/.test(k)) continue;
    env[k] = v;
  }
  for (const d of ["config", "data", "cache", "state"]) mkdirSync(join(home, d), { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Check", GIT_AUTHOR_EMAIL: "check@example.com", GIT_COMMITTER_NAME: "Check", GIT_COMMITTER_EMAIL: "check@example.com",
    NO_COLOR: "1",
  }, extra);
  return env;
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

// A new git repository on branch main, with one commit of the given files (and whatever is already in the folder).
export function gitRepo(dir: string, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "check@example.com");
  git(dir, "config", "user.name", "Check");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Start");
}

export const copyDir = (from: string, to: string) => cpSync(from, to, { recursive: true });

// Every file under dir, as absolute paths.
export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) return [];
    return s.isDirectory() ? walkFiles(p) : s.isFile() ? [p] : [];
  });
}

export function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// A glob as the problem file uses it: ** for any folders, * and ? inside one path part.
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}${g.endsWith("/") ? ".*" : ""}$`);
}

// The problems of the frozen zoo: every folder in swarm/zoo/ that holds a problem.json.
export function zooProblems(): string[] {
  if (!existsSync(ZOO)) return [];
  return readdirSync(ZOO).filter((f) => existsSync(join(ZOO, f, "problem.json"))).sort();
}

export type Kind = "real" | "noop" | "trap";
export interface MenuItem { summary: string; edits: { path: string; search: string; replace: string }[] }

export function zooTruth(problem: string): Record<string, Kind> {
  return JSON.parse(readFileSync(join(ZOO, problem, "truth.json"), "utf8"));
}

export function zooMenu(problem: string): MenuItem[] {
  return JSON.parse(readFileSync(join(ZOO, problem, "menu.json"), "utf8"));
}

export interface Attempt { summary?: unknown; kept?: unknown; reason?: unknown }

// The attempts list of a result.json, or a plain reason why there is none.
export function attemptsOf(result: unknown): Attempt[] | string {
  if (!isObject(result)) return "result.json is missing or is not a JSON object";
  if (!Array.isArray(result.attempts)) return "result.json has no attempts list";
  return result.attempts as Attempt[];
}

// Runs fn on every item with at most `limit` at once, and keeps the order of the items.
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export const tail = (text: string, lines = 15) => text.trim().split("\n").slice(-lines).join("\n");
