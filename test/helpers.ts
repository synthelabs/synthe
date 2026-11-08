import type { Goal, Scenario } from "../src/core/goal.ts";
import { DEFAULTS } from "../src/core/goal.ts";
import type { ScoreRow, RoundScores } from "../src/core/merge-rule.ts";
import { newState, type State } from "../src/core/state.ts";
import type { MergeResult, Refusal, Repo } from "../src/github/repo.ts";
import { sha256 } from "../src/core/safety.ts";

export const goal = (over: Partial<Goal> = {}): Goal => ({
  version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "Be right", guardrails: ["No lies"],
  scenarios: "s.jsonl", ...DEFAULTS, ...over,
});

export const rows = (scores: (number | null)[], violation: boolean | null = false, prefix = "s"): ScoreRow[] =>
  scores.map((score, i) => ({ id: `${prefix}${i}`, score, violation }));

export const trainRows = (score: number | null, violation: boolean | null = false) => rows(Array(20).fill(score), violation);
export const heldRows = (score: number | null, violation: boolean | null = false) => rows(Array(10).fill(score), violation, "h");

export const scored = (baseline: string, train: number, held: number, cand: number, candHeld: number): RoundScores => ({
  baselineHash: sha256(baseline), baselineTrain: trainRows(train), baselineHoldout: heldRows(held),
  candidates: [{ id: "c1", train: trainRows(cand), holdout: heldRows(candHeld) }],
});

export const scenarios: Scenario[] = [
  ...["a", "c", "d", "e", "f", "g"].map((id) => ({ id, input: "train question", expected: "good", split: "train" as const })),
  { id: "b", input: "HOLDOUT-SECRET question", expected: "good", split: "holdout" },
  // Three held-back cases, because a clear win must now also pass the held-back sign test (holdout_max_p 0.2):
  // one held-back win alone has p 0.5, three in a row 0.125.
  { id: "b2", input: "HOLDOUT-SECRET question two", expected: "good", split: "holdout" },
  { id: "b3", input: "HOLDOUT-SECRET question three", expected: "good", split: "holdout" },
];

export class MemoryRepo implements Repo {
  files = new Map<string, string>();
  state: State = newState();
  prs: { number: number; title: string; body: string; closed: boolean; branch: string; merged: boolean }[] = [];
  crashOn: "openPr" | "mergePr" | "upsertIssue" | null = null; // throws once at that step, like a job dying
  refuse: { openPr?: Refusal; upsertIssue?: Refusal } = {}; // refused on every call, like a repo setting that stays off
  merges: { pr: number; sha: string }[] = [];
  commits: { path: string; content: string }[] = [];
  issue = "";
  mergeResult: MergeResult = { merged: true };
  branches = new Map<string, string>();
  dispatches = 0;
  constructor(prompt: string, path = "prompt.md") { this.files.set(path, prompt); }
  async defaultBranch() { return "main"; }
  async dispatchWorkflow() { this.dispatches++; }
  async headSha() { return "head"; }
  async readFile(path: string) { return this.files.get(path) ?? null; }
  async commitFile(a: { branch: string; baseSha: string; path: string; content: string; message: string }) {
    this.commits.push({ path: a.path, content: a.content });
    this.branches.set(a.branch, a.content);
    return `sha-${this.commits.length}`;
  }
  private crash(step: string) { if (this.crashOn === step) { this.crashOn = null; throw new Error(`crashed at ${step}`); } }
  async openPr(a: { branch: string; title: string; body: string }) {
    this.crash("openPr");
    if (this.refuse.openPr) throw this.refuse.openPr;
    this.prs.push({ number: this.prs.length + 1, title: a.title, body: a.body, closed: false, branch: a.branch, merged: false });
    return this.prs.length;
  }
  async mergePr(number: number, sha: string) {
    if (this.mergeResult.merged) {
      this.merges.push({ pr: number, sha });
      this.prs[number - 1].merged = true;
      this.files.set(this.commits.at(-1)!.path, this.commits.at(-1)!.content);
    }
    this.crash("mergePr");
    return this.mergeResult;
  }
  async deleteBranch(b: string) { this.branches.delete(b); }
  async closePr(n: number) { this.prs[n - 1].closed = true; }
  async updatePrBody(n: number, body: string) { this.prs[n - 1].body = body; }
  async upsertIssue(n: number | null, _t: string, body: string) { this.crash("upsertIssue"); if (this.refuse.upsertIssue) throw this.refuse.upsertIssue; this.issue = body; return n ?? 99; }
  async findPr(branch: string) {
    const pr = [...this.prs].reverse().find((p) => p.branch === branch);
    return pr ? { number: pr.number, open: !pr.closed && !pr.merged, merged: pr.merged } : null;
  }
  async readState() { return structuredClone(this.state); }
  async writeState(s: State) { this.state = structuredClone(s); }
  stateFiles = new Map<string, string>(); // files on the state branch other than state.json, such as evidence
  async writeStateFile(path: string, content: string) { this.stateFiles.set(path, content); }
}
