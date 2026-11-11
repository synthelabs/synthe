// Experiment specification and the keep / hold / revert analysis. Lane: metric and experiment evaluation.
import type { ArmRef, BaselineReport, ExperimentAnalysis, ExperimentSpec, IsoTime, MetricContract, Sha256, Stored, TelemetryImport } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/experiment.ts is not built yet"); };

export function buildExperimentSpec(_input: {
  pilot_id: string; config_id: Sha256; contract: MetricContract; baseline: ArmRef; candidate: ArmRef;
  baseline_report: BaselineReport; start: IsoTime;
  // Intended share of traffic for the candidate. Absent: 0.5.
  candidate_share?: number;
}): ExperimentSpec { return todo(); }

// Pure, and never reads the clock: the same specification and imports always give the same analysis.
export function analyzeExperiment(_input: { spec: ExperimentSpec; experiment_id: Sha256; imports: Stored<TelemetryImport>[]; approval_id: Sha256 }): ExperimentAnalysis { return todo(); }

// Markdown the customer runs the experiment from.
export function renderExperimentSpec(_spec: ExperimentSpec, _experimentId: Sha256): string { return todo(); }

// Markdown decision for the operator: every number with its source and method.
export function renderDecision(_analysis: ExperimentAnalysis, _spec: ExperimentSpec, _analysisId: Sha256): string { return todo(); }
