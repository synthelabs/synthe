import type { ImproveConfig } from "../src/improve/config.ts";

// A custom-metric config every improve test starts from: 3 runs, higher is better, no guard, baseline 3 at "c".
export const custom = (command: string): ImproveConfig => ({
  version: 1,
  goal: "Make it better",
  metric: { preset: "custom", label: "valid signups", unit: "units", command, direction: "higher", runs: 3 },
  guard: { command: null },
  protect: [],
  mode: "review",
  baseline: { commit: "c", median: 3, runs: [3, 3, 3], at: "2026-11-07T00:00:00Z" },
});

export const config = (over: Partial<ImproveConfig> = {}): ImproveConfig => ({ ...custom("node metrics/score.js"), ...over });
