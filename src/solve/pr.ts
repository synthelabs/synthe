import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SolveResult } from "./types.ts";

// `solve --pr`: after a run that kept a change, push its branch to origin and open a pull request with report.md
// as the body. Every failure here is a plain error after the run: result.json, report.md and the local branch stay.

export interface Ran { code: number | null; stdout: string; stderr: string; missing: boolean }
export type Runner = (file: string, args: string[], o: { cwd: string; input?: string }) => Promise<Ran>;

// Runs a program with no shell. Never throws: a program that is not installed gives `missing: true`.
export const runFile: Runner = (file, args, o) => new Promise((resolve) => {
  const child = execFile(file, args, { cwd: o.cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
    const missing = e?.code === "ENOENT";
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (missing ? "" : e?.message ?? ""), missing });
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(o.input ?? "");
});

export interface PrOutcome { ok: boolean; message: string; url?: string }

const firstLine = (r: Ran) => (r.stderr.trim() || r.stdout.trim()).split("\n")[0] ?? "";

// Opens the pull request for a finished run. `repoRoot` is the person's repository; `reportPath` is report.md.
export async function openPullRequest(result: SolveResult, a: { repoRoot: string; reportPath: string; goal: string }, run: Runner = runFile): Promise<PrOutcome> {
  const branch = result.branch;
  if (!branch) return { ok: true, message: "No change was kept, so Synthe opened no pull request." };
  const keep = `The kept changes stay on the local branch ${branch}.`;

  // Check gh first, so a run that can not open the pull request pushes nothing.
  const auth = await run("gh", ["auth", "status"], { cwd: a.repoRoot });
  if (auth.missing) return { ok: false, message: `Synthe could not open the pull request: gh is not installed. Install the GitHub CLI (https://cli.github.com), run gh auth login, then run git push -u origin ${branch} and gh pr create --head ${branch}. ${keep}` };
  if (auth.code !== 0) return { ok: false, message: `Synthe could not open the pull request: gh is not logged in (${firstLine(auth)}). Run gh auth login, then run git push -u origin ${branch} and gh pr create --head ${branch}. ${keep}` };

  let body: string;
  try { body = readFileSync(a.reportPath, "utf8"); } catch {
    return { ok: false, message: `Synthe could not read ${a.reportPath} for the pull request body. ${keep}` };
  }

  // gh gives the credentials for this one push, so no token has to stay in .git/config, where the measure's code
  // could read it (templates/synthe-solve.yml checks out with persist-credentials: false).
  const viaGh = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  const push = await run("git", ["-C", a.repoRoot, ...viaGh, "push", "--quiet", "-u", "origin", branch], { cwd: a.repoRoot });
  if (push.code !== 0) return { ok: false, message: `Synthe could not push ${branch} to origin (${firstLine(push)}). Check that you can push to this repository, then run git push -u origin ${branch}. ${keep}` };

  const current = await run("git", ["-C", a.repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: a.repoRoot });
  const baseName = current.code === 0 ? current.stdout.trim() : "";
  const base = baseName && baseName !== "HEAD" && !baseName.startsWith("synthe/") ? ["--base", baseName] : [];
  const title = `Synthe: ${a.goal}`.replace(/\s+/g, " ").slice(0, 120);
  const created = await run("gh", ["pr", "create", ...base, "--head", branch, "--title", title, "--body-file", "-"], { cwd: a.repoRoot, input: body });
  if (created.code !== 0) return { ok: false, message: `Synthe pushed ${branch} but gh could not open the pull request (${firstLine(created)}). Open it on GitHub from ${branch}.` };
  const url = created.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  return { ok: true, url, message: `Opened the pull request ${url} from ${branch}.` };
}
