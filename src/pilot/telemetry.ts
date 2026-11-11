// Read-only telemetry boundary: customer exports in, validated imports and a baseline report out.
// Lane: metric and experiment evaluation.
import type { BaselineReport, IsoTime, MetricContract, Sha256, Stored, TelemetryImport } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/telemetry.ts is not built yet"); };

export interface ImportInput {
  // The export file's text (JSON).
  text: string;
  // Reads a file next to the export file (rows_csv). Absent: rows_csv is refused.
  readSibling?: (name: string) => string;
  purpose: "baseline" | "experiment";
  scope_id: Sha256;
  contract: MetricContract;
  // Every prompt_version the export may contain. Any other tag refuses the whole import.
  tags: string[];
  // experiment: the specification's window. Rows that started outside it refuse the import.
  window?: { start: IsoTime; end: IsoTime };
}

// Validates one export. Throws PilotError telemetry_* / invalid_telemetry.
export function importTelemetry(_input: ImportInput): TelemetryImport { return todo(); }

export function baselineReport(_input: { config_id: Sha256; contract: MetricContract; tag: string; imports: Stored<TelemetryImport>[] }): BaselineReport { return todo(); }

export function renderBaseline(_report: BaselineReport, _contract: MetricContract, _baselineId: Sha256): string { return todo(); }
