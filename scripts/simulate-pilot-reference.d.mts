export const PLAN: { days: number; lag_days: number; per_day: number; min_effect: number; escalated_max_harm: number; early_stop_min_per_arm: number; refund_max_harm: number };
export const SCENARIOS: Record<string, { base: { resolved: number; escalated: number; refunded: number; refund_usd: number }; cand: { resolved: number; escalated: number; refunded: number; refund_usd: number } }>;
export function earlyStopLooks(): { day: number; n: number }[];
export function atMost(p: number, runs: number): number;
export function atLeast(p: number, runs: number): number;
export function limits(runs: number): { scenario: string; measure: string; kind: "max" | "min"; theory: number; limit: number; why: string }[];
