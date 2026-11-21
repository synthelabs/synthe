// The swarm's shared ledger: the project state that every agent reads and writes. It lives on the `ledger` branch of
// this repository, kept in a worktree at .git/swarm-ledger. Every write is a commit that is pushed at once.
//
// Each agent appends only to its own files, so two agents never edit the same file. A claim is a new file
// claims/<task>.json: if another agent pushed the same claim first, the push is refused, the claim reads as taken,
// and the command fails. This is the only lock, and it is enough.
//
// Tables (folders on the ledger branch):
//   announce/<agent>.jsonl  orders to the whole team (the lead writes them)
//   assign/<agent>.jsonl    who works on which milestone; the latest row for a helper wins
//   notes/<agent>.jsonl     the open board: plans, progress, verdicts, check bugs, blocks
//   tasks/<id>.json         the to-do list; any agent adds tasks; the id is <agent>-<n>
//   claims/<id>.json        who owns a task (first claim wins)
//   done/<id>.json          finished tasks
//   landed/<agent>.jsonl    work that merged into integration
//
// Usage (run `whoami <id>` once; or set SWARM_AGENT; or pass --as <agent>):
//   node scripts/swarm/ledger.mjs whoami [<id>]
//   node scripts/swarm/ledger.mjs status [--milestone P03]
//   node scripts/swarm/ledger.mjs ready [--milestone P03]
//   node scripts/swarm/ledger.mjs announce "<text>"
//   node scripts/swarm/ledger.mjs assign <agent> <milestone> [--role captain|crew]
//   node scripts/swarm/ledger.mjs note "<text>" [--kind plan|progress|verdict|check-bug|blocked|free] [--milestone P03] [--task <id>]
//   node scripts/swarm/ledger.mjs task "<title>" --milestone P03 [--parent <id>]
//   node scripts/swarm/ledger.mjs claim <id>
//   node scripts/swarm/ledger.mjs release <id>
//   node scripts/swarm/ledger.mjs done <id> [--pr <url>]
//   node scripts/swarm/ledger.mjs land "<summary>" --milestone P03 --pr <url>
//   node scripts/swarm/ledger.mjs wait [--seconds 540]     returns when the ledger changes, or at the time limit
//   node scripts/swarm/ledger.mjs log [--since <iso>] [--limit 40]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRANCH = process.env.SWARM_LEDGER_BRANCH ?? "ledger";
const REMOTE = process.env.SWARM_LEDGER_REMOTE ?? "origin";

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) opt[k] = true; else { opt[k] = v; i++; } }
    else pos.push(argv[i]);
  }
  return { pos, opt };
}
const { pos, opt } = parse(process.argv.slice(2));
const cmd = pos.shift();
const die = (msg) => { console.error(msg); process.exit(1); };
const now = () => new Date().toISOString();
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitDir = resolve(repo, git(repo, "rev-parse", "--git-common-dir"));
// The agent id: --as, then SWARM_AGENT, then .git/swarm-agent (written once by `node scripts/swarm/ledger.mjs whoami <id>`).
const idFile = join(gitDir, "swarm-agent");
const agent = String(opt.as ?? process.env.SWARM_AGENT ?? (existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : ""));
const wt = process.env.SWARM_LEDGER_DIR ?? join(gitDir, "swarm-ledger");

function sync() {
  git(repo, "fetch", "-q", REMOTE, `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`);
  if (!existsSync(join(wt, ".git"))) {
    try { git(repo, "worktree", "prune"); } catch { /* nothing to prune */ }
    git(repo, "worktree", "add", "-q", "--detach", wt, `${REMOTE}/${BRANCH}`);
  }
  git(wt, "reset", "-q", "--hard", `${REMOTE}/${BRANCH}`);
  git(wt, "clean", "-qfd");
}

// Write with retries: sync, check, change, commit, push. If another agent pushed first, start again from their state.
function write(message, change) {
  if (!agent) die("Set SWARM_AGENT to your agent id (for example h07), or pass --as <agent>.");
  for (let attempt = 1; attempt <= 10; attempt++) {
    sync();
    const result = change();
    if (git(wt, "status", "--porcelain") === "") return result; // nothing to write, such as a claim another agent holds
    git(wt, "add", "-A");
    git(wt, "-c", `user.name=swarm-${agent}`, "-c", "user.email=swarm@users.noreply.github.com", "commit", "-q", "-m", `${agent}: ${message}`);
    try { git(wt, "push", "-q", REMOTE, `HEAD:refs/heads/${BRANCH}`); return result; }
    catch { execFileSync("sleep", [String(Math.min(8, attempt) * (0.5 + Math.random()))]); }
  }
  die("The ledger push failed 10 times. Check the network, then run the command again.");
}

const readJsonl = (dir) => !existsSync(join(wt, dir)) ? [] : readdirSync(join(wt, dir)).filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(join(wt, dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .sort((a, b) => a.at.localeCompare(b.at));
const readDir = (dir) => !existsSync(join(wt, dir)) ? new Map() : new Map(readdirSync(join(wt, dir)).filter((f) => f.endsWith(".json"))
  .map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(wt, dir, f), "utf8"))]));
const append = (dir, row) => { mkdirSync(join(wt, dir), { recursive: true }); appendFileSync(join(wt, dir, `${agent}.jsonl`), `${JSON.stringify({ at: now(), by: agent, ...row })}\n`); };
const createOnly = (dir, id, row) => {
  const path = join(wt, dir, `${id}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  mkdirSync(join(wt, dir), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ at: now(), by: agent, ...row })}\n`);
  return null;
};
const need = (v, what) => { if (v === undefined || v === true || v === "") die(`Missing ${what}. Run with no command for the usage.`); return String(v); };

function state() {
  const tasks = readDir("tasks"), claims = readDir("claims"), done = readDir("done");
  const assign = new Map();
  for (const a of readJsonl("assign")) assign.set(a.agent, a);
  return { tasks, claims, done, assign, announce: readJsonl("announce"), notes: readJsonl("notes"), landed: readJsonl("landed") };
}
const taskLine = (id, t, s) => `${id.padEnd(14)} ${(t.milestone ?? "").padEnd(6)} ${s.done.has(id) ? "done   " : s.claims.has(id) ? `claimed by ${s.claims.get(id).by}` : "ready  "}  ${t.title}${t.parent ? `  (under ${t.parent})` : ""}`;

switch (cmd) {
  case "whoami": {
    if (pos[0]) { if (!/^[a-z0-9-]+$/.test(pos[0])) die("An agent id uses only a-z, 0-9 and -."); writeFileSync(idFile, `${pos[0]}\n`); console.log(`You are ${pos[0]}.`); }
    else console.log(agent || "No agent id yet. Run `node scripts/swarm/ledger.mjs whoami <id>`.");
    break;
  }
  case "status": {
    sync();
    const s = state(), ms = opt.milestone;
    console.log("== Latest orders"); for (const a of s.announce.slice(-8)) console.log(`${a.at} ${a.by}: ${a.text}`);
    if (agent) console.log(`\n== Your assignment (${agent}): ${s.assign.has(agent) ? `${s.assign.get(agent).milestone} as ${s.assign.get(agent).role}` : "none yet"}`);
    const crews = new Map();
    for (const a of s.assign.values()) crews.set(a.milestone, [...(crews.get(a.milestone) ?? []), a.role === "captain" ? `${a.agent}*` : a.agent]);
    console.log("\n== Crews (* = captain)"); for (const [m, c] of [...crews].sort()) console.log(`${m.padEnd(6)} ${c.join(" ")}`);
    console.log("\n== Tasks"); for (const [id, t] of s.tasks) if (!ms || t.milestone === ms) if (!s.done.has(id)) console.log(taskLine(id, t, s));
    console.log(`(${[...s.tasks.keys()].filter((id) => s.done.has(id)).length} done tasks hidden)`);
    console.log("\n== Recent notes"); for (const n of s.notes.filter((n) => !ms || n.milestone === ms).slice(-15)) console.log(`${n.at} ${n.by} [${n.kind}${n.milestone ? ` ${n.milestone}` : ""}] ${n.text}`);
    console.log("\n== Landed"); for (const l of s.landed.slice(-10)) console.log(`${l.at} ${l.by} ${l.milestone}: ${l.text} ${l.pr ?? ""}`);
    break;
  }
  case "ready": {
    sync();
    const s = state();
    for (const [id, t] of s.tasks) if (!s.claims.has(id) && !s.done.has(id) && (!opt.milestone || t.milestone === opt.milestone)) console.log(taskLine(id, t, s));
    break;
  }
  case "announce": { const text = need(pos[0], "the text"); write("announce", () => append("announce", { text })); console.log("Announced."); break; }
  case "assign": {
    const who = need(pos[0], "the agent"), milestone = need(pos[1], "the milestone"), role = opt.role === "captain" ? "captain" : "crew";
    write(`assign ${who} to ${milestone}`, () => append("assign", { agent: who, milestone, role })); console.log(`Assigned ${who} to ${milestone} as ${role}.`); break;
  }
  case "note": {
    const text = need(pos[0], "the text");
    write(`note ${opt.kind ?? "progress"}`, () => append("notes", { kind: String(opt.kind ?? "progress"), milestone: opt.milestone, task: opt.task, text })); console.log("Noted."); break;
  }
  case "task": {
    const title = need(pos[0], "the title"), milestone = need(opt.milestone, "--milestone");
    const id = write(`task for ${milestone}`, () => {
      const n = [...readDir("tasks").keys()].filter((k) => k.startsWith(`${agent}-`)).length + 1;
      createOnly("tasks", `${agent}-${n}`, { title, milestone, parent: opt.parent });
      return `${agent}-${n}`;
    });
    console.log(id); break;
  }
  case "claim": {
    const id = need(pos[0], "the task id"); let taken = null;
    write(`claim ${id}`, () => {
      if (!readDir("tasks").has(id)) die(`No task ${id}. Run \`ready\` for the open tasks.`);
      if (readDir("done").has(id)) die(`Task ${id} is already done.`);
      taken = createOnly("claims", id, {});
    });
    if (taken && taken.by !== agent) die(`Task ${id} is already claimed by ${taken.by}. Run \`ready\` and claim another one.`);
    console.log(`You own ${id}.`); break;
  }
  case "release": {
    const id = need(pos[0], "the task id");
    write(`release ${id}`, () => { const c = readDir("claims").get(id); if (!c || c.by !== agent) die(`You do not own ${id}.`); rmSync(join(wt, "claims", `${id}.json`)); });
    console.log(`Released ${id}.`); break;
  }
  case "done": {
    const id = need(pos[0], "the task id");
    write(`done ${id}`, () => { if (!readDir("tasks").has(id)) die(`No task ${id}.`); createOnly("done", id, { pr: opt.pr }); });
    console.log(`Marked ${id} done.`); break;
  }
  case "land": {
    const text = need(pos[0], "the summary"), milestone = need(opt.milestone, "--milestone"), pr = need(opt.pr, "--pr");
    write(`landed ${milestone}`, () => append("landed", { milestone, text, pr })); console.log("Logged."); break;
  }
  case "wait": {
    const limit = Number(opt.seconds ?? 540) * 1000, start = Date.now();
    sync(); const before = git(wt, "rev-parse", "HEAD");
    while (Date.now() - start < limit) {
      execFileSync("sleep", ["20"]);
      sync();
      const head = git(wt, "rev-parse", "HEAD");
      if (head !== before) { console.log(git(wt, "log", "--format=%cI %s", `${before}..${head}`)); process.exit(0); }
    }
    console.log("No change in the ledger."); break;
  }
  case "log": {
    sync();
    const args = ["log", "--format=%cI %s", `-${Number(opt.limit ?? 40)}`];
    if (opt.since) args.push(`--since=${opt.since}`);
    console.log(git(wt, ...args)); break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(cmd ? 1 : 0);
}
