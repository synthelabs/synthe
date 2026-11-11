import { githubRepo, type Repo } from "../github/repo.ts";
import { PilotError } from "./errors.ts";

type ReviewFile = Parameters<Repo["commitFile"]>[0];

export interface ReviewPr {
  number: number;
  state: string;
  base: string;
  head: string;
  headSha: string;
  body: string;
}

export interface PilotRepo extends Pick<Repo, "slug" | "headSha" | "readFile" | "openPr"> {
  findReviewPr(branch: string): Promise<ReviewPr | null>;
  commitReview(file: ReviewFile): Promise<string>;
  matchesReview(sha: string, file: ReviewFile): Promise<boolean>;
}

export function pilotGithubRepo(slug: string, token: string, api: string): PilotRepo {
  const repo = githubRepo(slug, token, api);
  const request = (method: string, path: string, body?: object) => fetch(`${api}/repos/${slug}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "synthe",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const json = async (res: Response) => {
    if (!res.ok) throw new PilotError("conflict", `GitHub could not verify or publish the review (HTTP ${res.status}). Check the review branch before retrying.`);
    return res.json();
  };
  const matchesReview = async (sha: string, file: ReviewFile) => {
    const commit = await json(await request("GET", `/commits/${encodeURIComponent(sha)}`));
    return commit.sha === sha && commit.parents?.length === 1 && commit.parents[0].sha === file.baseSha
      && commit.files?.length === 1 && commit.files[0].filename === file.path && commit.files[0].status === "modified"
      && await repo.readFile(file.path, sha) === file.content;
  };
  return {
    slug, headSha: repo.headSha, readFile: repo.readFile, openPr: repo.openPr,
    async findReviewPr(branch) {
      const owner = slug.split("/")[0];
      const pulls = await json(await request("GET", `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`));
      if (!Array.isArray(pulls) || pulls.length > 1) throw new PilotError("conflict", "The review branch has ambiguous pull request history. Check it before retrying.");
      const pr = pulls[0];
      if (!pr) return null;
      if ([pr.base, pr.head].some((side) => side?.repo?.full_name?.toLowerCase() !== slug.toLowerCase())) {
        throw new PilotError("conflict", "The existing pull request points to another repository or its branch is unavailable.");
      }
      return { number: pr.number, state: pr.state, base: pr.base.ref, head: pr.head.ref, headSha: pr.head.sha, body: pr.body };
    },
    async commitReview(file) {
      const { branch, baseSha, path, content, message } = file;
      const created = await request("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: baseSha });
      if (created.status !== 422) await json(created);
      const head = await repo.headSha(branch);
      if (head !== baseSha) {
        if (await matchesReview(head, file)) return head;
        throw new PilotError("wrong_revision", "The review branch contains an unexpected commit. It was left in place.");
      }
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const blob = await json(await request("GET", `/contents/${encoded}?ref=${encodeURIComponent(baseSha)}`));
      const result = await json(await request("PUT", `/contents/${encoded}`, {
        branch, message, sha: blob.sha, content: Buffer.from(content, "utf8").toString("base64"),
      }));
      return result.commit.sha;
    },
    matchesReview,
  };
}
