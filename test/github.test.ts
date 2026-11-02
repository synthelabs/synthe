import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { githubRepo } from "../src/github/repo.ts";
import { newState } from "../src/core/state.ts";

const calls: { method: string; url: string; body: any }[] = [];
const files = new Map<string, string>([["main:prompt.md", "Old"]]);
let merge = { status: 200, body: "x", headers: {} as Record<string, string> };
let mergeQueue: typeof merge[] = []; // answered first, one per call, to test retries
const waits: number[] = [];

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url!, "http://x");
    calls.push({ method: req.method!, url: req.url!, body });
    const send = (code: number, value?: unknown) => { res.statusCode = code; res.end(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)); };
    const path = url.pathname.replace("/repos/o/r", "");
    assert.equal(req.headers.authorization, "Bearer tok");
    if (path === "") return send(200, { default_branch: "main" });
    if (path.startsWith("/git/ref/heads/")) {
      const b = decodeURIComponent(path.slice(15));
      return b === "main" || [...files.keys()].some((k) => k.startsWith(`${b}:`)) ? send(200, { object: { sha: "headsha" } }) : send(404, {});
    }
    if (path === "/git/refs") {
      const b = body.ref.slice(11);
      if ([...files.keys()].some((k) => k.startsWith(`${b}:`))) return send(422, { message: "Reference already exists" });
      files.set(`${b}:.keep`, ""); return send(201, {});
    }
    if (path.startsWith("/git/refs/heads/") && req.method === "PATCH") return send(200, {});
    if (path === "/pulls" && req.method === "GET") {
      const head = url.searchParams.get("head");
      return send(200, head === "o:synthe/round-1" ? [{ number: 7, state: "closed", merged_at: "2026-11-02T00:00:00Z" }] : []);
    }
    if (path.startsWith("/contents/")) {
      const key = `${req.method === "PUT" ? body.branch : url.searchParams.get("ref")}:${path.slice(10)}`;
      if (req.method === "PUT") {
        files.set(key, Buffer.from(body.content, "base64").toString());
        return send(200, { commit: { sha: "newsha" } });
      }
      if (!files.has(key)) return send(404, {});
      return req.headers.accept?.includes("raw") ? send(200, files.get(key)) : send(200, { sha: "blob" });
    }
    if (path === "/pulls") return send(201, { number: 7 });
    if (path === "/pulls/7/merge") {
      const m = mergeQueue.shift() ?? merge;
      for (const [k, v] of Object.entries(m.headers)) res.setHeader(k, v);
      return send(m.status, { message: m.body });
    }
    if (path === "/issues") return send(201, { number: 3 });
    if (path.startsWith("/issues/")) return send(200, {});
    send(404, {});
  });
});

let repo: ReturnType<typeof githubRepo>;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  repo = githubRepo("o/r", "tok", `http://127.0.0.1:${(server.address() as any).port}`, async (ms) => { waits.push(ms); });
});
after(() => server.close());

test("reads files, and missing is null", async () => {
  assert.equal(await repo.readFile("prompt.md", "main"), "Old");
  assert.equal(await repo.readFile("nope.md", "main"), null);
});

test("commits on a new branch and merges with the pinned sha", async () => {
  const sha = await repo.commitFile({ branch: "synthe/round-1", baseSha: "headsha", path: "prompt.md", content: "New", message: "m" });
  assert.equal(sha, "newsha");
  assert.equal(files.get("synthe/round-1:prompt.md"), "New");
  assert.equal(await repo.openPr({ branch: "synthe/round-1", base: "main", title: "t", body: "b" }), 7);
  assert.deepEqual(await repo.mergePr(7, "newsha"), { merged: true });
  assert.deepEqual(calls.at(-1)!.body, { sha: "newsha", merge_method: "squash" });
});

test("each merge failure is told apart: rules, permissions, token, rate limit, moved branch", async () => {
  const problem = async (status: number, body = "x", headers: Record<string, string> = {}) => {
    merge = { status, body, headers };
    const r = await repo.mergePr(7, "s");
    merge = { status: 200, body: "x", headers: {} };
    return r.merged ? "merged" : r.problem;
  };
  assert.equal(await problem(405), "blocked");
  assert.equal(await problem(403, "Resource not accessible by integration"), "permission");
  assert.equal(await problem(401), "token");
  assert.equal(await problem(409), "moved");
  assert.equal(await problem(403, "You have exceeded a secondary rate limit"), "rate_limited");
  assert.equal(await problem(403, "x", { "x-ratelimit-remaining": "0" }), "rate_limited");
  assert.equal(await problem(429), "rate_limited");
});

test("a rate limit is waited out and retried before giving up", async () => {
  waits.length = 0;
  mergeQueue = [{ status: 429, body: "slow down", headers: { "retry-after": "2" } }];
  assert.deepEqual(await repo.mergePr(7, "s"), { merged: true });
  assert.deepEqual(waits, [2000]);
});

test("a GitHub server error is retried after a short pause", async () => {
  waits.length = 0;
  mergeQueue = [{ status: 502, body: "bad gateway", headers: {} }];
  assert.deepEqual(await repo.mergePr(7, "s"), { merged: true });
  assert.deepEqual(waits, [5000]);
});

test("a branch left behind by a crashed round is moved, not a failure", async () => {
  files.set("synthe/round-9:.keep", "");
  const sha = await repo.commitFile({ branch: "synthe/round-9", baseSha: "headsha", path: "prompt.md", content: "Again", message: "m" });
  assert.equal(sha, "newsha");
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/git/refs/heads/synthe%2Fround-9") && c.body.force === true));
});

test("finds a round's pull request by branch", async () => {
  assert.deepEqual(await repo.findPr("synthe/round-1"), { number: 7, open: false, merged: true });
  assert.equal(await repo.findPr("synthe/none"), null);
});

test("state starts new, then round-trips on its own branch", async () => {
  assert.deepEqual(await repo.readState(), newState());
  await repo.writeState({ ...newState(), round: 4 });
  assert.equal((await repo.readState()).round, 4);
});

test("creates then updates the report issue", async () => {
  assert.equal(await repo.upsertIssue(null, "t", "b"), 3);
  assert.equal(await repo.upsertIssue(3, "t", "b2"), 3);
});
