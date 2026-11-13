// A company's metric, read for each arm over one time window. A source answers with the arms it was asked for,
// or with one plain sentence saying what is wrong, so the caller can show it and never has to catch a crash.
import type { ArmData } from "../live/gate.ts";

export interface MetricQuery { agent: string; from: string; to: string; arms: string[] }
export type MetricResult = { arms: Record<string, ArmData> } | { problem: string };
export interface MetricSource { read(q: MetricQuery): Promise<MetricResult> }
