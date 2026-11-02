import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { githubRepo } from "../src/github/repo.ts";
import { newState } from "../src/core/state.ts";

const calls: { method: string; url: string; body: any }[] = [];
const files = new Map<string, string>([["main:prompt.md", "Old"]]);
let mergeStatus = 200;

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
    if (path === "/git/refs") { files.set(`${body.ref.slice(11)}:.keep`, ""); return send(201, {}); }
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
    if (path === "/pulls/7/merge") return send(mergeStatus, { message: "x" });
    if (path === "/issues") return send(201, { number: 3 });
    if (path.startsWith("/issues/")) return send(200, {});
    send(404, {});
  });
});

let repo: ReturnType<typeof githubRepo>;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  repo = githubRepo("o/r", "tok", `http://127.0.0.1:${(server.address() as any).port}/repos`.replace("/repos", ""));
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

test("a 405 is reported as a blocked repo, a 409 as a moved branch", async () => {
  mergeStatus = 405;
  assert.equal(((await repo.mergePr(7, "s")) as any).blocked, true);
  mergeStatus = 409;
  assert.equal(((await repo.mergePr(7, "s")) as any).blocked, false);
  mergeStatus = 200;
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
