// Approved failures become regression cases in a new pack version. Lane: evidence and review workflow.
import type { Pack, PackSummary, PromotionRecord, PromotionRequest, ReplayReport, Sha256, Split, Stored } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/promote.ts is not built yet"); };

export interface EligibleFailure { replay_id: Sha256; arm: "baseline" | "candidate"; case_id: string; split: Split; turn: number; check_id: string }

// Every decided check failure in the stored replays: what a reviewer may approve as a regression case.
export function eligibleFailures(_replays: Stored<ReplayReport>[]): EligibleFailure[] { return todo(); }

// The next pack version. The input pack is not changed. Throws PilotError invalid_promotion, holdout_leak.
export function promote(_input: { pack: Stored<Pack>; request: Stored<PromotionRequest>; replays: Stored<ReplayReport>[]; experiment_ids: Sha256[] }): Pack { return todo(); }

export function renderPromotion(_record: PromotionRecord, _before: PackSummary, _after: PackSummary): string { return todo(); }
