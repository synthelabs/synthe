// Collects how every registered team's run is going, as numbers only, for the hackathon dashboard.
// Usage: node scripts/collect-runs.ts [--repos owner/a,owner/b] [--out runs.json]
// Without --repos it reads the registry (teams that agreed to share at `npx synthe init`). Needs `gh` signed in.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { REGISTRY } from "../src/cli/init.ts";
import { STATE_BRANCH } from "../src/core/goal.ts";
import { scorecard, summarize, type Registration } from "../src/runs/summary.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const tryGh = (...args: string[]) => { try { return gh(...args); } catch { return null; } };
const SLUG = /^[\w.-]+\/[\w.-]+$/;

function registrations(): Registration[] {
  const listed = arg("--repos");
  if (listed) return listed.split(",").map((repo) => ({ repo: repo.trim() }));
  const issues = JSON.parse(gh("api", "--paginate", `repos/${REGISTRY}/issues?state=all&per_page=100`)) as { title: string; body: string | null; pull_request?: unknown }[];
  const seen = new Map<string, Registration>();
  for (const i of issues) {
    const repo = i.title.replace(/^run: /, "").trim();
    if (i.pull_request || !SLUG.test(repo)) continue;
    // The body was written by a team's setup; only its times and mode are used, and only if they parse.
    let body: Partial<Registration> = {};
    // Setup writes one JSON block; anything around it (a template, a footer) is ignored.
    const block = /\{[\s\S]*?\n\}/.exec(i.body ?? "")?.[0] ?? "{}";
    try { body = JSON.parse(block); } catch { /* keep the repo, drop the details */ }
    seen.set(repo, { repo, startedAt: String(body.startedAt ?? ""), finishedAt: String(body.finishedAt ?? ""), mode: String(body.mode ?? "") });
  }
  return [...seen.values()];
}

const runs = registrations().map((reg) => {
  const raw = tryGh("api", `repos/${reg.repo}/contents/state.json?ref=${encodeURIComponent(STATE_BRANCH)}`, "-H", "Accept: application/vnd.github.raw+json");
  let state = null;
  try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
  let up = 0, down = 0;
  if (typeof state?.issue === "number") {
    const reactions = tryGh("api", `repos/${reg.repo}/issues/${state.issue}/reactions`);
    for (const r of reactions ? (JSON.parse(reactions) as { content: string }[]) : []) { if (r.content === "+1") up++; if (r.content === "-1") down++; }
  }
  return summarize(reg, state, { up, down });
});

const out = { collectedAt: new Date().toISOString(), scorecard: scorecard(runs), runs };
const file = arg("--out");
if (file) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
else console.log(JSON.stringify(out, null, 2));
