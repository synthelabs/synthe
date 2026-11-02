import type { State } from "../core/state.ts";

// One team's run, reduced to numbers. Built only from fields that hold no prompt, scenario or reply text, so
// nothing a team wrote can leave their repo through this.
export interface RunSummary {
  repo: string;
  readable: boolean;
  setupSeconds: number | null;
  registeredAt: string | null;
  mode: string | null;
  rounds: number;
  merged: number;
  proposed: number;
  declined: number;
  reverted: number;
  failed: number;
  spendUsd: number;
  firstMergeRound: number | null;
  firstMergeAt: string | null;
  lastRoundAt: string | null;
  status: "running" | "waiting for review" | "finished" | "stopped" | "not started";
  stopReason: string | null;
  thumbsUp: number;
  thumbsDown: number;
}

export interface Registration { repo: string; startedAt?: string; finishedAt?: string; mode?: string }

const FINISHED = /^(budget of .* is used|reached \d+ rounds|\d+ rounds in a row found no winner)$/;

export function summarize(reg: Registration, state: Partial<State> | null, reactions: { up: number; down: number } = { up: 0, down: 0 }): RunSummary {
  const started = Date.parse(reg.startedAt ?? ""), finished = Date.parse(reg.finishedAt ?? "");
  const rounds = Array.isArray(state?.rounds) ? state!.rounds : [];
  const count = (o: string) => rounds.filter((r) => r?.outcome === o).length;
  const firstMerge = rounds.find((r) => r?.outcome === "merged");
  const stopped = typeof state?.stopped === "string" ? state.stopped : null;
  return {
    repo: reg.repo,
    readable: state !== null,
    setupSeconds: Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? Math.round((finished - started) / 1000) : null,
    registeredAt: reg.finishedAt ?? null,
    mode: typeof reg.mode === "string" ? reg.mode : null,
    rounds: typeof state?.round === "number" ? state.round : 0,
    merged: count("merged"),
    proposed: count("proposed"),
    declined: count("declined"),
    reverted: count("reverted"),
    failed: count("failed"),
    spendUsd: typeof state?.spendUsd === "number" ? Math.round(state.spendUsd * 100) / 100 : 0,
    firstMergeRound: firstMerge?.round ?? null,
    firstMergeAt: firstMerge?.at ?? null,
    lastRoundAt: rounds.at(-1)?.at ?? null,
    status: state === null || rounds.length === 0 ? "not started" : state.proposal ? "waiting for review" : !stopped ? "running" : FINISHED.test(stopped) ? "finished" : "stopped",
    stopReason: stopped,
    thumbsUp: reactions.up,
    thumbsDown: reactions.down,
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// The hackathon scorecard: the numbers to watch overnight and report afterwards.
export function scorecard(runs: RunSummary[]) {
  const started = runs.filter((r) => r.rounds > 0);
  const merges = runs.reduce((n, r) => n + r.merged, 0);
  return {
    teamsRegistered: runs.length,
    teamsStarted: started.length,
    teamsUnreadable: runs.filter((r) => !r.readable).length,
    medianSetupSeconds: median(runs.flatMap((r) => (r.setupSeconds === null ? [] : [r.setupSeconds]))),
    teamsWithAMerge: runs.filter((r) => r.merged > 0).length,
    merges,
    reverts: runs.reduce((n, r) => n + r.reverted, 0),
    revertsPerMerge: merges ? Math.round((runs.reduce((n, r) => n + r.reverted, 0) / merges) * 100) / 100 : null,
    proposalsDeclined: runs.reduce((n, r) => n + r.declined, 0),
    teamsInReviewMode: runs.filter((r) => r.mode === "propose").length,
    failedRounds: runs.reduce((n, r) => n + r.failed, 0),
    totalSpendUsd: Math.round(runs.reduce((n, r) => n + r.spendUsd, 0) * 100) / 100,
    medianSpendUsd: median(started.map((r) => r.spendUsd)),
    stopReasons: Object.fromEntries([...new Set(runs.map((r) => r.stopReason).filter(Boolean))].map((s) => [s, runs.filter((r) => r.stopReason === s).length])),
    thumbsUp: runs.reduce((n, r) => n + r.thumbsUp, 0),
    thumbsDown: runs.reduce((n, r) => n + r.thumbsDown, 0),
  };
}
