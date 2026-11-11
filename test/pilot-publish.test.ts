import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { githubRepo } from "../src/github/repo.ts";
import { sensitiveIndex } from "../src/pilot/egress.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { promptId, reviewBranch } from "../src/pilot/ids.ts";
import { publishReview, type PublishInput } from "../src/pilot/publish.ts";
import { renderReview } from "../src/pilot/review.ts";
import {
  BASELINE_PROMPT, BRANCH, CANARY_ORDER, CANARY_SENTENCE, CANARY_TOOL_ARG, CANDIDATE_PROMPT, PROMPT_PATH, SLUG, fixture, stored,
} from "./pilot-review-helpers.ts";

// A loopback fake of the few GitHub endpoints githubRepo uses. It records every request it receives.
interface Seen { method: string; path: string; body: string; auth: string | undefined }
let seen: Seen[] = [];
let branches: Map<string, Map<string, string>>;
let pulls: { number: number; state: string; head: string; title: string; body: string; base: string }[];

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url!, "http://x");
    seen.push({ method: req.method!, path: req.url!, body: raw, auth: req.headers.authorization });
    const body = raw ? JSON.parse(raw) : undefined;
    const send = (code: number, value?: unknown) => { res.statusCode = code; res.end(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)); };
    const path = url.pathname.replace(`/repos/${SLUG}`, "");
    if (path.startsWith("/git/ref/heads/")) {
      const b = decodeURIComponent(path.slice(15));
      return branches.has(b) ? send(200, { object: { sha: `sha-of-${b}` } }) : send(404, {});
    }
    if (path === "/git/refs" && req.method === "POST") {
      const b = body.ref.slice(11);
      if (branches.has(b)) return send(422, { message: "Reference already exists" });
      branches.set(b, new Map(branches.get("main")));
      return send(201, {});
    }
    if (path.startsWith("/git/refs/heads/") && req.method === "PATCH") {
      branches.set(decodeURIComponent(path.slice(16)), new Map(branches.get("main")));
      return send(200, {});
    }
    if (path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice(10));
      if (req.method === "PUT") {
        branches.get(body.branch)!.set(file, Buffer.from(body.content, "base64").toString());
        return send(200, { commit: { sha: "commit-sha" } });
      }
      const text = branches.get(url.searchParams.get("ref")!)?.get(file);
      if (text === undefined) return send(404, {});
      return req.headers.accept?.includes("raw") ? send(200, text) : send(200, { sha: "blob" });
    }
    if (path === "/pulls" && req.method === "GET") {
      const head = url.searchParams.get("head")!;
      return send(200, pulls.filter((p) => `fernhill:${p.head}` === head));
    }
    if (path === "/pulls" && req.method === "POST") {
      const n = pulls.length + 1;
      pulls.push({ number: n, state: "open", head: body.head, base: body.base, title: body.title, body: body.body });
      return send(201, { number: n });
    }
    send(404, {});
  });
});

let api = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
beforeEach(() => {
  seen = [];
  pulls = [];
  branches = new Map([["main", new Map([[PROMPT_PATH, BASELINE_PROMPT]])]]);
});

const f = fixture();
const repo = () => githubRepo(SLUG, "tok", api);
const writes = () => seen.filter((s) => s.method !== "GET");

function input(over: Partial<PublishInput> = {}): PublishInput {
  const body = renderReview(f.bundle.value, "a".repeat(64), f.pack.value, "looks_up_order");
  return {
    config: f.config, bundle: f.bundle, body, candidate_prompt: CANDIDATE_PROMPT,
    operator: { publish: true, repo: SLUG, base: "main", confirm: f.bundle.value.candidate_id },
    sensitive: sensitiveIndex([f.pack.value], [BASELINE_PROMPT]),
    ...over,
  };
}
const refuses = async (code: string, over: Partial<PublishInput>) => {
  await assert.rejects(publishReview(repo(), input(over)), (e: unknown) => e instanceof PilotError && e.code === code);
  assert.equal(seen.length, 0, "a refusal before the network sends nothing");
};

test("publishing is off by default and sends nothing", async () => {
  await refuses("unauthorized_publish", { operator: { publish: false, repo: SLUG, base: "main", confirm: f.bundle.value.candidate_id } });
  await refuses("unauthorized_publish", { operator: { publish: undefined as unknown as boolean, repo: SLUG, base: "main", confirm: f.bundle.value.candidate_id } });
});

test("a wrong, short or empty confirmation sends nothing", async () => {
  for (const confirm of ["", f.bundle.value.candidate_id.slice(0, 12), "0".repeat(64)]) {
    await refuses("unauthorized_publish", { operator: { publish: true, repo: SLUG, base: "main", confirm } });
  }
});

test("a wrong repo or base sends nothing", async () => {
  await refuses("wrong_repo", { operator: { publish: true, repo: "fernhill/other", base: "main", confirm: f.bundle.value.candidate_id } });
  await refuses("wrong_repo", { operator: { publish: true, repo: SLUG, base: "develop", confirm: f.bundle.value.candidate_id } });
  await refuses("wrong_repo", { config: { ...f.config, repo: { ...f.config.repo, slug: "fernhill/other" } } });
  await assert.rejects(publishReview({ ...repo(), slug: "fernhill/other" }, input()), (e: unknown) => e instanceof PilotError && e.code === "wrong_repo");
  assert.equal(seen.length, 0);
  const moved = { ...f.bundle, value: { ...f.bundle.value, repo: { ...f.bundle.value.repo, base: "develop" } } };
  await refuses("wrong_repo", { bundle: moved });
});

test("an ineligible gate sends nothing", async () => {
  const value = { ...f.bundle.value, replay: { ...f.bundle.value.replay, gate: { eligible: false, reasons: ["net wins 0"] } } };
  await refuses("replay_gate_failed", { bundle: { id: f.bundle.id, value } });
});

test("a candidate prompt that is not the bundle's candidate sends nothing", async () => {
  await refuses("conflict", { candidate_prompt: CANDIDATE_PROMPT + "Also be rude.\n" });
});

test("a body, or a candidate prompt, containing pack text sends nothing", async () => {
  const leaky = input().body + `\n\nThe customer said: ${CANARY_SENTENCE}.\n`;
  await refuses("egress_blocked", { body: leaky });
  await refuses("egress_blocked", { body: input().body + `\nOrder ${CANARY_ORDER}\n` });
  const prompt = CANDIDATE_PROMPT + `Remember ${CANARY_SENTENCE}.\n`;
  // A consistent bundle for this prompt, so that only the prompt text itself can stop the publication.
  const id = promptId(prompt);
  const bundle = stored({ ...f.bundle.value, candidate_id: id, repo: { ...f.bundle.value.repo, branch: reviewBranch(id) } });
  await assert.rejects(
    publishReview(repo(), input({ candidate_prompt: prompt, bundle, operator: { publish: true, repo: SLUG, base: "main", confirm: id } })),
    (e: unknown) => e instanceof PilotError && e.code === "egress_blocked" && /candidate prompt/.test(e.message),
  );
  assert.equal(seen.length, 0);
});

test("a body with an email sends nothing", async () => {
  await refuses("egress_blocked", { body: input().body + "\nask pat@example.com\n" });
});

test("a tampered bundle sends nothing", async () => {
  const bundle = { id: f.bundle.id, value: { ...f.bundle.value, rationale: "changed after it was named" } };
  await refuses("tampered", { bundle });
});

test("a base branch whose prompt changed is refused with only reads", async () => {
  branches.get("main")!.set(PROMPT_PATH, BASELINE_PROMPT + "A new line someone merged.\n");
  await assert.rejects(publishReview(repo(), input()), (e: unknown) => e instanceof PilotError && e.code === "wrong_revision");
  assert.ok(seen.length > 0);
  assert.deepEqual(writes(), []);
});

test("a missing prompt file is refused with only reads", async () => {
  branches.get("main")!.delete(PROMPT_PATH);
  await assert.rejects(publishReview(repo(), input()), (e: unknown) => e instanceof PilotError && e.code === "wrong_revision" && /not found/.test(e.message));
  assert.deepEqual(writes(), []);
});

test("the happy path makes one commit and one pull request, and a second call adopts it", async () => {
  const r = await publishReview(repo(), input());
  assert.deepEqual(r, { pr: 1, branch: BRANCH, adopted: false });
  assert.equal(branches.get(BRANCH)!.get(PROMPT_PATH), CANDIDATE_PROMPT);
  assert.equal(branches.get("main")!.get(PROMPT_PATH), BASELINE_PROMPT, "the base branch is never written");
  const puts = seen.filter((s) => s.method === "PUT");
  const posts = seen.filter((s) => s.method === "POST" && s.path.endsWith("/pulls"));
  assert.equal(puts.length, 1);
  assert.equal(posts.length, 1);
  const pr = JSON.parse(posts[0].body);
  assert.equal(pr.head, BRANCH);
  assert.equal(pr.base, "main");
  assert.equal(pr.title, `Synthe pilot fernhill-pilot: candidate ${f.bundle.value.candidate_id.slice(0, 12)}`);
  assert.equal(pr.body, input().body);
  assert.equal(JSON.parse(puts[0].body).branch, BRANCH);

  seen = [];
  const again = await publishReview(repo(), input());
  assert.deepEqual(again, { pr: 1, branch: BRANCH, adopted: true });
  assert.deepEqual(writes(), [], "adopting writes nothing");
  assert.equal(pulls.length, 1);
});

test("an existing closed or merged pull request is adopted too", async () => {
  pulls.push({ number: 9, state: "closed", head: BRANCH, base: "main", title: "t", body: "b" });
  const r = await publishReview(repo(), input());
  assert.deepEqual(r, { pr: 9, branch: BRANCH, adopted: true });
  assert.deepEqual(writes(), []);
});

for (const point of ["after-commit", "after-open-pr"]) {
  test(`a crash at ${point} followed by a retry leaves exactly one pull request`, async () => {
    const crash = (p: string) => { if (p === point) throw new Error("injected crash"); };
    await assert.rejects(publishReview(repo(), input({ fault: crash })), /injected crash/);
    const retry = await publishReview(repo(), input());
    assert.equal(pulls.length, 1);
    assert.equal(retry.pr, 1);
    assert.equal(retry.adopted, point === "after-open-pr");
    assert.equal(branches.get(BRANCH)!.get(PROMPT_PATH), CANDIDATE_PROMPT);
    // A third attempt changes nothing.
    await publishReview(repo(), input());
    assert.equal(pulls.length, 1);
  });
}

test("no request carries pack text, and the token only goes to the loopback server", async () => {
  await publishReview(repo(), input());
  await publishReview(repo(), input());
  assert.ok(seen.length > 0);
  for (const s of seen) {
    for (const canary of [CANARY_SENTENCE, CANARY_ORDER, CANARY_TOOL_ARG, "I am sorry about that"]) assert.ok(!s.body.includes(canary) && !s.path.includes(canary));
    assert.equal(s.auth, "Bearer tok");
    // The token never appears in a path or a body.
    assert.ok(!s.body.includes("tok\"") && !s.path.includes("tok"));
  }
  assert.ok(api.startsWith("http://127.0.0.1:"));
});
