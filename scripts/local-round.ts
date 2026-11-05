// Runs real Synthe rounds on this computer, so a change to Synthe can be tried on a real agent before it ships.
// Each round runs the workflow's three steps (write, score, decide) as separate processes, the way GitHub runs them,
// against a stand-in for GitHub kept in a folder. Nothing touches GitHub or Actions. The model calls are real, so a
// round costs what it would in a team's repo (about $0.10 on the support-bot example).
//
//   ANTHROPIC_API_KEY=... node scripts/local-round.ts <agent-folder> [--rounds N] [--fresh] [--bundle]
//                                                    [--review merge|close] [--workspace DIR]
//
// <agent-folder> is a set-up project (synthe.json, its scenarios and its prompt), such as examples/support-bot. It is
// copied in once and never changed; the workspace keeps the stand-in repo, so later runs continue the same run.
//   --fresh      start over from the agent folder
//   --bundle     run the built dist/action.mjs instead of src/action.ts (what teams get)
//   --review     merge or close a proposal waiting for review before each round, as a person would
// Every round adds a line to <workspace>/runs.jsonl with Synthe's commit, so results can be compared across changes,
// and <workspace>/view/ shows what a team would see on GitHub: the report issue, each pull request, the prompt.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Files = Record<string, string>;
interface Pull { number: number; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean }
interface Store {
  next: number;
  commits: Record<string, Files>;
  branches: Record<string, string>;
  // The commit each branch was cut from, so a squash merge carries only that branch's own changes.
  roots: Record<string, string>;
  pulls: Pull[];
  issues: { number: number; title: string; body: string }[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "local";
const MAX_FILE = 512 * 1024;
// Folders a checkout never needs; other dot-folders are skipped too, except the two Synthe reads.
const SKIP = new Set(["node_modules", ".git", ".synthe-out", "dist", "build"]);

function options() {
  const a = process.argv.slice(2);
  const value = (name: string) => { const i = a.indexOf(`--${name}`); return i >= 0 ? a[i + 1] : undefined; };
  const target = a.find((x, i) => !x.startsWith("--") && !["--rounds", "--review", "--workspace"].includes(a[i - 1]));
  const review = value("review");
  if (!target || (review !== undefined && review !== "merge" && review !== "close")) {
    console.log("Usage: node scripts/local-round.ts <agent-folder> [--rounds N] [--fresh] [--bundle] [--review merge|close] [--workspace DIR]");
    process.exit(2);
  }
  const name = basename(resolve(target));
  return {
    target: resolve(target), name, rounds: Number(value("rounds") ?? 1), fresh: a.includes("--fresh"), bundle: a.includes("--bundle"),
    review: review as "merge" | "close" | undefined, workspace: resolve(value("workspace") ?? join(tmpdir(), "synthe-local", name)),
  };
}

// The agent's project as text files, the way a checkout would see it.
function snapshot(dir: string, base = dir, out: Files = {}): Files {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || (entry.name.startsWith(".") && ![".synthe", ".github"].includes(entry.name))) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { snapshot(full, base, out); continue; }
    if (!entry.isFile() || statSync(full).size > MAX_FILE) continue;
    const text = readFileSync(full, "utf8");
    if (!text.includes("\u0000")) out[relative(base, full).split("\\").join("/")] = text;
  }
  return out;
}

function checkout(files: Files, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(store: Store, files: Files): string {
  const sha = createHash("sha1").update(`${store.next++}\u0000${JSON.stringify(files)}`).digest("hex");
  store.commits[sha] = files;
  return sha;
}

// A squash merge: the base branch gets the pull request's own changes as one new commit.
function squash(store: Store, pr: Pull) {
  const head = store.commits[store.branches[pr.head]];
  const root = store.commits[store.roots[pr.head]] ?? {};
  const changed = Object.fromEntries(Object.entries(head).filter(([k, v]) => root[k] !== v));
  store.branches[pr.base] = commit(store, { ...store.commits[store.branches[pr.base]], ...changed });
  pr.state = "closed";
  pr.merged = true;
}

// GitHub's REST API, only as far as Synthe uses it (src/github/repo.ts). Returns [status, body].
function route(store: Store, name: string, method: string, url: URL, raw: boolean, body: any): [number, unknown?] {
  const prefix = `/repos/${OWNER}/${name}`;
  if (!url.pathname.startsWith(prefix)) return [404, { message: "Not Found" }];
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  const pull = (n: string) => store.pulls.find((p) => p.number === Number(n));
  let m: RegExpMatchArray | null;

  if (path === "" && method === "GET") return [200, { default_branch: "main" }];
  if ((m = path.match(/^\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
    const sha = store.branches[m[1]];
    return sha ? [200, { object: { sha } }] : [404, { message: "Not Found" }];
  }
  if (path === "/git/refs" && method === "POST") {
    const branch = body.ref.replace(/^refs\/heads\//, "");
    if (store.branches[branch]) return [422, { message: "Reference already exists" }];
    if (!store.commits[body.sha]) return [422, { message: "Object does not exist" }];
    store.branches[branch] = store.roots[branch] = body.sha;
    return [201, { object: { sha: body.sha } }];
  }
  if ((m = path.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
    if (!store.commits[body.sha]) return [422, { message: "Object does not exist" }];
    store.branches[m[1]] = store.roots[m[1]] = body.sha;
    return [200, { object: { sha: body.sha } }];
  }
  if ((m = path.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "DELETE") {
    if (!store.branches[m[1]]) return [422, { message: "Reference does not exist" }];
    delete store.branches[m[1]];
    delete store.roots[m[1]];
    return [204];
  }
  if ((m = path.match(/^\/contents\/(.+)$/)) && method === "GET") {
    const ref = url.searchParams.get("ref") ?? "main";
    const sha = store.branches[ref] ?? (store.commits[ref] ? ref : undefined);
    const text = sha ? store.commits[sha][m[1]] : undefined;
    if (text === undefined) return [404, { message: "Not Found" }];
    return [200, raw ? text : { sha: createHash("sha1").update(text).digest("hex") }];
  }
  if ((m = path.match(/^\/contents\/(.+)$/)) && method === "PUT") {
    const from = store.branches[body.branch];
    if (!from) return [404, { message: `Branch ${body.branch} not found` }];
    const sha = commit(store, { ...store.commits[from], [m[1]]: Buffer.from(body.content, "base64").toString("utf8") });
    store.branches[body.branch] = sha;
    return [200, { commit: { sha } }];
  }
  if (path === "/pulls" && method === "POST") {
    if (!store.branches[body.head]) return [422, { message: "Validation Failed: head" }];
    // Pull requests and issues share one numbering on GitHub.
    const pr: Pull = { number: store.pulls.length + store.issues.length + 1, head: body.head, base: body.base, title: body.title, body: body.body, state: "open", merged: false };
    store.pulls.push(pr);
    return [201, { number: pr.number }];
  }
  if (path === "/pulls" && method === "GET") {
    const head = url.searchParams.get("head")?.replace(`${OWNER}:`, "");
    return [200, store.pulls.filter((p) => !head || p.head === head).reverse().map((p) => ({ number: p.number, state: p.state, merged_at: p.merged ? "merged" : null }))];
  }
  if ((m = path.match(/^\/pulls\/(\d+)\/merge$/)) && method === "PUT") {
    const pr = pull(m[1]);
    if (!pr) return [404, { message: "Not Found" }];
    if (pr.state !== "open") return [405, { message: "Pull Request is not mergeable" }];
    if (body.sha && body.sha !== store.branches[pr.head]) return [409, { message: "Head branch was modified" }];
    squash(store, pr);
    return [200, { merged: true }];
  }
  if ((m = path.match(/^\/pulls\/(\d+)$/))) {
    const pr = pull(m[1]);
    if (!pr) return [404, { message: "Not Found" }];
    if (method === "GET") return [200, { number: pr.number, state: pr.state, merged: pr.merged }];
    if (method === "PATCH") {
      Object.assign(pr, { body: body.body ?? pr.body, title: body.title ?? pr.title, state: body.state === "closed" ? "closed" : pr.state });
      return [200, { number: pr.number }];
    }
  }
  if (path === "/issues" && method === "POST") {
    const number = store.pulls.length + store.issues.length + 1;
    store.issues.push({ number, title: body.title, body: body.body });
    return [201, { number }];
  }
  if ((m = path.match(/^\/issues\/(\d+)$/)) && method === "PATCH") {
    const issue = store.issues.find((i) => i.number === Number(m![1]));
    if (!issue) return [404, { message: "Not Found" }];
    Object.assign(issue, { title: body.title ?? issue.title, body: body.body ?? issue.body });
    return [200, { number: issue.number }];
  }
  // Loud on purpose: a call Synthe makes that this stand-in doesn't know is a gap to fill, not a silent pass.
  console.error(`  [stand-in] no route for ${method} ${path}`);
  return [404, { message: "Not Found" }];
}

function standIn(store: Store, name: string, save: () => void) {
  return createServer((req, res) => {
    let text = "";
    req.on("data", (d) => (text += d));
    req.on("end", () => {
      const [status, value] = route(store, name, req.method!, new URL(req.url!, "http://local"), Boolean(req.headers.accept?.includes("raw")), text ? JSON.parse(text) : undefined);
      if (req.method !== "GET") save();
      res.statusCode = status;
      res.setHeader("content-type", typeof value === "string" ? "text/plain" : "application/json");
      res.end(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
    });
  });
}

// One workflow step as its own process, with the environment GitHub gives an action.
function step(o: { entry: string; dir: string; step: string; api: string; name: string; key: string }) {
  const cwd = join(o.dir, o.step);
  const out = join(o.dir, `${o.step}.out`);
  writeFileSync(out, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|INPUT_|RUNNER_|ANTHROPIC_API_KEY$)/.test(k)));
  Object.assign(env, {
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: `${OWNER}/${o.name}`, GITHUB_API_URL: o.api,
    GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(o.dir, `${o.step}.summary.md`), INPUT_STEP: o.step, "INPUT_GITHUB-TOKEN": "local",
    // The decide job holds no model key, as in the workflow.
    "INPUT_ANTHROPIC-API-KEY": o.step === "decide" ? "" : o.key,
  });
  return new Promise<{ code: number; go: string }>((done) => {
    const child = spawn(process.execPath, [o.entry], { cwd, env });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => {
      writeFileSync(join(o.dir, `${o.step}.log`), log);
      const go = /^go=(.*)$/m.exec(readFileSync(out, "utf8"))?.[1] ?? "";
      done({ code: code ?? 1, go });
    });
  });
}

function syntheVersion() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "templates"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}+changes` : sha;
  } catch { return "unknown"; }
}

function copyIf(from: string, to: string) {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

// What a person would look at on GitHub, as plain files: the report issue, each pull request, the state, the prompt.
function view(workspace: string, store: Store) {
  const dir = join(workspace, "view");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const report = store.issues.at(-1);
  if (report) writeFileSync(join(dir, "report.md"), `# ${report.title}\n\n${report.body}\n`);
  for (const p of store.pulls) writeFileSync(join(dir, `pr-${p.number}.md`), `# #${p.number} ${p.title}\n\n${p.merged ? "merged" : p.state} · ${p.head} -> ${p.base}\n\n${p.body}\n`);
  const state = store.commits[store.branches["synthe/state"] ?? ""]?.["state.json"];
  if (state) writeFileSync(join(dir, "state.json"), state);
  const main = store.commits[store.branches.main];
  try {
    const path = JSON.parse(main["synthe.json"]).prompt.path;
    if (main[path] !== undefined) writeFileSync(join(dir, basename(path)), main[path]);
  } catch { /* a broken goal file shows up in the step logs instead */ }
}

async function main() {
  const o = options();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.log("Set ANTHROPIC_API_KEY first: local rounds make real model calls."); process.exit(2); }
  if (!existsSync(join(o.target, "synthe.json"))) {
    console.log(`${o.target} has no synthe.json. Point this at a set-up project, such as examples/support-bot.`);
    process.exit(2);
  }
  const entry = join(ROOT, o.bundle ? "dist/action.mjs" : "src/action.ts");
  const file = join(o.workspace, "github.json");
  if (o.fresh) rmSync(o.workspace, { recursive: true, force: true });
  mkdirSync(o.workspace, { recursive: true });

  let store: Store;
  if (existsSync(file)) {
    store = JSON.parse(readFileSync(file, "utf8"));
  } else {
    store = { next: 0, commits: {}, branches: {}, roots: {}, pulls: [], issues: [] };
    store.branches.main = commit(store, snapshot(o.target));
  }
  const save = () => writeFileSync(file, JSON.stringify(store));
  save();
  const server = standIn(store, o.name, save);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const version = syntheVersion();
  console.log(`Synthe ${version} (${o.bundle ? "dist bundle" : "src"}) on ${o.name}. Workspace: ${o.workspace}`);

  for (let i = 0; i < o.rounds; i++) {
    const open = store.pulls.find((p) => p.state === "open");
    if (open && o.review) {
      if (o.review === "merge") squash(store, open);
      else open.state = "closed";
      save();
      console.log(`Review: ${o.review === "merge" ? "merged" : "closed"} #${open.number}, as a person would.`);
    }
    const n = readdirSync(o.workspace).filter((d) => d.startsWith("round-")).length + 1;
    const dir = join(o.workspace, `round-${String(n).padStart(2, "0")}`);
    const artifacts = join(dir, "artifacts", ".synthe-out");
    const files = store.commits[store.branches.main]; // every job checks out the commit the run started on
    const started = Date.now();
    const run = (name: string) => step({ entry, dir, step: name, api, name: o.name, key });

    // The same jobs, conditions and artifacts as templates/synthe.yml.
    checkout(files, join(dir, "write"));
    const write = await run("write");
    if (write.go === "true") copyIf(join(dir, "write/.synthe-out/candidates.json"), join(artifacts, "candidates.json"));
    if (write.code !== 0) copyIf(join(dir, "write/.synthe-out/error.json"), join(artifacts, "error.json"));
    let score: { code: number } | null = null;
    if (write.go === "true") {
      checkout(files, join(dir, "score"));
      copyIf(join(artifacts, "candidates.json"), join(dir, "score/.synthe-out/candidates.json"));
      score = await run("score");
      if (score.code === 0) copyIf(join(dir, "score/.synthe-out/scores.json"), join(artifacts, "scores.json"));
      else copyIf(join(dir, "score/.synthe-out/error.json"), join(artifacts, "error.json"));
    }
    let decide: { code: number } | null = null;
    if (write.go !== "false") {
      mkdirSync(join(dir, "decide"), { recursive: true });
      copyIf(join(dir, "artifacts"), join(dir, "decide"));
      decide = await run("decide");
    }

    const stateText = store.commits[store.branches["synthe/state"] ?? ""]?.["state.json"];
    const state = stateText ? JSON.parse(stateText) : null;
    const last = state?.rounds?.at(-1);
    const fresh = Boolean(last && Date.parse(last.at) >= started);
    const record = {
      at: new Date().toISOString(), synthe: version, entry: o.bundle ? "bundle" : "src", agent: o.name,
      jobs: { write: write.code, go: write.go, score: score?.code ?? null, decide: decide?.code ?? null },
      round: fresh ? last.round : null,
      outcome: fresh ? last.outcome : write.go === "check" ? "waiting for review" : write.go === "false" ? "not run" : "no record",
      costUsd: fresh ? last.costUsd : null, checks: fresh ? last.checks ?? null : null, pr: fresh ? last.pr ?? null : null,
      stopped: state?.stopped ?? null, seconds: Math.round((Date.now() - started) / 1000),
    };
    appendFileSync(join(o.workspace, "runs.jsonl"), `${JSON.stringify(record)}\n`);
    view(o.workspace, store);

    const failed = [write.code, score?.code, decide?.code].some((c) => typeof c === "number" && c !== 0);
    const money = record.costUsd === null ? "cost unknown" : `$${record.costUsd.toFixed(2)}`;
    const checks = record.checks ? `, checks ${record.checks.before}% -> ${record.checks.after}%` : "";
    console.log(`${basename(dir)}: ${record.outcome}${record.pr ? ` #${record.pr}` : ""}${checks}, ${money}, ${record.seconds}s${failed ? " (a job failed; see its .log)" : ""}`);
    if (fresh && last.plain) console.log(`  ${last.plain}`);
    if (record.stopped) { console.log(`Stopped: ${record.stopped}`); break; }
  }
  server.close();
  console.log(`Report: ${join(o.workspace, "view", "report.md")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
