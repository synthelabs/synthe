// The metric contract: validation. Lane: metric and experiment evaluation.
import type { MetricContract } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/metric.ts is not built yet"); };

// Validates the `metric` object of pilot.json. Throws PilotError invalid_metric with a plain sentence.
export function parseMetricContract(_value: unknown): MetricContract { return todo(); }
