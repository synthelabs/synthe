import { STATE_BRANCH } from "../core/goal.ts";
import { newState, type State } from "../core/state.ts";

export type MergeResult = { merged: true } | { merged: false; why: string; blocked: boolean };

export interface Repo {
  defaultBranch(): Promise<string>;
  headSha(branch: string): Promise<string>;
  readFile(path: string, ref: string): Promise<string | null>;
  commitFile(a: { branch: string; baseSha: string; path: string; content: string; message: string }): Promise<string>;
  openPr(a: { branch: string; base: string; title: string; body: string }): Promise<number>;
  mergePr(number: number, sha: string): Promise<MergeResult>;
  deleteBranch(branch: string): Promise<void>;
  closePr(number: number): Promise<void>;
  upsertIssue(number: number | null, title: string, body: string): Promise<number>;
  readState(): Promise<State>;
  writeState(state: State): Promise<void>;
}

const STATE_PATH = "state.json";

export function githubRepo(slug: string, token: string, api = "https://api.github.com"): Repo {
  const call = async (method: string, path: string, body?: unknown, accept = "application/vnd.github+json") => {
    return fetch(`${api}/repos/${slug}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synthe" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
  const createBranch = (branch: string, sha: string) => json("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });

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
      const why = `${res.status} ${(await res.text()).slice(0, 200)}`;
      // 405 is a repo rule or review requirement; other failures are usually a moved branch.
      return { merged: false, why, blocked: res.status === 405 || res.status === 403 };
    },
    async deleteBranch(branch) { await call("DELETE", `/git/refs/heads/${encodeURIComponent(branch)}`); },
    async closePr(number) { await call("PATCH", `/pulls/${number}`, { state: "closed" }); },
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
