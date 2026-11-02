import { STATE_BRANCH } from "../core/goal.ts";
import { newState, type State } from "../core/state.ts";

// Why a merge didn't happen. blocked, permission and token need a person; the rest are worth another round.
export type MergeProblem = "blocked" | "permission" | "token" | "rate_limited" | "moved" | "other";
export type MergeResult = { merged: true } | { merged: false; why: string; problem: MergeProblem };
export interface PrInfo { number: number; open: boolean; merged: boolean }

const isRateLimited = (status: number, headers: Headers, text: string) =>
  status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text)));

export interface Repo {
  defaultBranch(): Promise<string>;
  headSha(branch: string): Promise<string>;
  readFile(path: string, ref: string): Promise<string | null>;
  commitFile(a: { branch: string; baseSha: string; path: string; content: string; message: string }): Promise<string>;
  openPr(a: { branch: string; base: string; title: string; body: string }): Promise<number>;
  mergePr(number: number, sha: string): Promise<MergeResult>;
  deleteBranch(branch: string): Promise<void>;
  closePr(number: number): Promise<void>;
  updatePrBody(number: number, body: string): Promise<void>;
  findPr(branch: string): Promise<PrInfo | null>;
  upsertIssue(number: number | null, title: string, body: string): Promise<number>;
  readState(): Promise<State>;
  writeState(state: State): Promise<void>;
}

const STATE_PATH = "state.json";

const RETRIES = 2;
const sleepFor = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function githubRepo(slug: string, token: string, api = "https://api.github.com", sleep = sleepFor): Repo {
  // GitHub's rate limits answer 429, or 403 with a rate-limit sign: wait as asked (at most a minute) and try again.
  // Server errors are retried after a short pause.
  const call = async (method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${api}/repos/${slug}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synthe" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (attempt >= RETRIES) return res;
      // GitHub's own hiccups (500, 502, 503, 504) usually pass in seconds. Only requests that are safe to repeat are
      // retried: a POST or PUT may have taken effect before the error, so repeating it could open a second pull
      // request or issue, or misread a merge that already happened.
      if (res.status >= 500) {
        if (method === "POST" || method === "PUT") return res;
        await sleep(5_000);
        continue;
      }
      if (res.status !== 429 && res.status !== 403) return res;
      const text = await res.clone().text();
      if (!isRateLimited(res.status, res.headers, text)) return res;
      const wait = Number(res.headers.get("retry-after"));
      await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 20_000, 60_000));
    }
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };
  const blobSha = async (path: string, branch: string): Promise<string | undefined> => {
    const res = await call("GET", `/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
    return res.ok ? (await res.json()).sha : undefined;
  };
  const putFile = async (branch: string, path: string, content: string, message: string): Promise<string> => {
    const sha = await blobSha(path, branch);
    const out = await json("PUT", `/contents/${encodeURI(path)}`, {
      message, branch, sha, content: Buffer.from(content, "utf8").toString("base64"),
    });
    return out.commit.sha;
  };
  // Safe to repeat: a branch left behind by a crashed round is moved to the new commit instead of failing.
  const createBranch = async (branch: string, sha: string) => {
    const res = await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
    if (res.ok) return;
    if (res.status === 422) return void await json("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: true });
    throw new Error(`GitHub POST /git/refs: ${res.status} ${(await res.text()).slice(0, 300)}`);
  };

  const repo: Repo = {
    async defaultBranch() { return (await json("GET", "")).default_branch; },
    async headSha(branch) { return (await json("GET", `/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha; },
    async readFile(path, ref) {
      const res = await call("GET", `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw+json");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub read ${path}: ${res.status}`);
      return res.text();
    },
    async commitFile({ branch, baseSha, path, content, message }) {
      await createBranch(branch, baseSha);
      return putFile(branch, path, content, message);
    },
    async openPr({ branch, base, title, body }) {
      return (await json("POST", "/pulls", { head: branch, base, title, body })).number;
    },
    async mergePr(number, sha) {
      const res = await call("PUT", `/pulls/${number}/merge`, { sha, merge_method: "squash" });
      if (res.ok) return { merged: true };
      const text = await res.text();
      const why = `${res.status} ${text.slice(0, 200)}`;
      const problem: MergeProblem = isRateLimited(res.status, res.headers, text) ? "rate_limited"
        : res.status === 405 ? "blocked" // a branch rule or required review
        : res.status === 401 ? "token"
        : res.status === 403 ? "permission"
        : res.status === 409 ? "moved"
        : "other";
      return { merged: false, why, problem };
    },
    async deleteBranch(branch) { await call("DELETE", `/git/refs/heads/${encodeURIComponent(branch)}`); },
    async closePr(number) { await call("PATCH", `/pulls/${number}`, { state: "closed" }); },
    async updatePrBody(number, body) { await call("PATCH", `/pulls/${number}`, { body }); },
    async findPr(branch) {
      const owner = slug.split("/")[0];
      const list = await json("GET", `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      const pr = Array.isArray(list) ? list[0] : undefined;
      return pr ? { number: pr.number, open: pr.state === "open", merged: Boolean(pr.merged_at) } : null;
    },
    async upsertIssue(number, title, body) {
      if (number !== null) { await json("PATCH", `/issues/${number}`, { title, body }); return number; }
      return (await json("POST", "/issues", { title, body })).number;
    },
    async readState() {
      const text = await repo.readFile(STATE_PATH, STATE_BRANCH);
      return text === null ? newState() : { ...newState(), ...JSON.parse(text) };
    },
    async writeState(state) {
      const exists = await blobSha(STATE_PATH, STATE_BRANCH) !== undefined;
      if (!exists) {
        const res = await call("GET", `/git/ref/heads/${encodeURIComponent(STATE_BRANCH)}`);
        if (res.status === 404) await createBranch(STATE_BRANCH, await repo.headSha(await repo.defaultBranch()));
      }
      await putFile(STATE_BRANCH, STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, `Synthe round ${state.round}`);
    },
  };
  return repo;
}
