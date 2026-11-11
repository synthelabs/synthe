// Replay of one prompt, and the paired comparison of two. Lane: replay and failure discovery.
import type { ArmRun, ChatModel, Pack, ReplayGateConfig, ReplayReport, ReplaySettings, Sha256, Split } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/replay.ts is not built yet"); };

export interface ReplayArmInput {
  pack: Pack;
  pack_id: Sha256;
  prompt: string;
  settings: ReplaySettings;
  model: ChatModel;
  // Replay only this split. Absent: every case.
  split?: Split;
}

// Replays every assistant turn of every case against the recorded history, with recorded tool results only.
export function replayArm(_input: ReplayArmInput): Promise<ArmRun> { return todo(); }

export interface PairInput {
  pack: Pack;
  baseline: ArmRun;
  candidate: ArmRun;
  target_check_id: string | null;
  gate: ReplayGateConfig;
}

// Pure: the paired report and the review gate, from two arm runs on the same pack with the same settings.
export function pairArms(_input: PairInput): ReplayReport { return todo(); }

// Markdown for the operator. Case ids, turns, check ids and catalog sentences only: no conversation text.
export function renderReplay(_report: ReplayReport, _pack: Pack, _replayId: Sha256): string { return todo(); }
