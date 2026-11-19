// Reference values for scripts/simulate-pilot.ts, worked out from theory alone.
//
// This file shares no code with src/pilot/: it has its own normal distribution and its own arithmetic, so a mistake
// in the pilot's statistics cannot also be in the number it is checked against. The limits below were written before
// the simulation was first run. They are never changed to make a run pass: a measured rate outside its limit is a
// finding about the decision rule (or about this reasoning), and is reported as one.
//
// Changes after the first run, all stricter, none to make a run pass (2026-11-19, after an independent review):
//  - Rates in the middle of the range get an additive tolerance (TOL) when it is tighter than the multiplicative
//    SLACK; before, a limit such as "lift_min keep at most 76%" could not catch a rule that kept far too often.
//  - Two scenarios for the refund guard (a mean guard, not critical), which had no limit of its own.
//
// Print them with: node scripts/simulate-pilot-reference.mjs

// Abramowitz and Stegun 7.1.26; absolute error below 1.5e-7, far below any limit here.
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const Z_975 = 1.959964; // two-sided 95%
const Z_9995 = 3.290527; // two-sided 99.9%, the early-stop level

// The experiment every scenario runs, as the simulation sets it up (the demo contract).
export const PLAN = {
  days: 14, // analysis window
  lag_days: 2,
  per_day: 640, // conversations a day, split between the arms by a fair coin
  min_effect: 0.03, // primary: resolved, higher is better
  escalated_max_harm: 0.02, // critical guard with an early stop from 400 values per arm
  early_stop_min_per_arm: 400,
  refund_max_harm: 0.75, // mean guard, USD per conversation
};

// What the customer's traffic really does in each arm. A conversation is resolved, or escalated, or neither; a
// refund of a fixed amount happens independently.
const BASE = { resolved: 0.62, escalated: 0.12, refunded: 0.15, refund_usd: 28 };
export const SCENARIOS = {
  // No difference at all.
  aa: { base: BASE, cand: BASE },
  // The true gain equals the minimum effect the contract asks for.
  lift_min: { base: BASE, cand: { ...BASE, resolved: 0.65 } },
  // The true gain is twice the minimum effect, with no harm.
  lift_double: { base: BASE, cand: { ...BASE, resolved: 0.68 } },
  // A clear gain, and a critical guard whose true harm is exactly the tolerated amount.
  harm_boundary: { base: BASE, cand: { ...BASE, resolved: 0.68, escalated: 0.14 } },
  // A clear gain, and a critical guard whose true harm is twice the tolerated amount.
  harm_double: { base: BASE, cand: { ...BASE, resolved: 0.68, escalated: 0.16 } },
  // The candidate hands twice as many conversations to people (the demo's reverted change).
  harm_large: { base: BASE, cand: { ...BASE, resolved: 0.63, escalated: 0.24 } },
  // A clear gain, and refunds whose true harm is exactly the tolerated amount (0.15 x $33 - 0.15 x $28 = $0.75).
  refund_boundary: { base: BASE, cand: { ...BASE, resolved: 0.68, refund_usd: 33 } },
  // A clear gain, and refunds whose true harm is twice the tolerated amount (0.15 x $38 - 0.15 x $28 = $1.50).
  refund_double: { base: BASE, cand: { ...BASE, resolved: 0.68, refund_usd: 38 } },
};

const perArm = (PLAN.days * PLAN.per_day) / 2;
const rateSe = (p1, p2, n) => Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / n);

// Chance that the measured primary gain reaches min_effect (the interval is then above zero as well, because its
// half-width at this size is below min_effect).
const primaryClears = (s) => 1 - phi((PLAN.min_effect - (s.cand.resolved - s.base.resolved)) / rateSe(s.base.resolved, s.cand.resolved, perArm));
// Chance that the primary is significantly worse at the final analysis (the whole 95% interval below zero).
const primaryWorse = (s) => phi((-(s.cand.resolved - s.base.resolved)) / rateSe(s.base.resolved, s.cand.resolved, perArm) - Z_975);
// Chance that the escalation guard is shown safe (whole 95% interval for harm inside the margin), or breached (whole
// interval beyond it), at n values per arm.
const escPass = (s, n = perArm) => { const se = rateSe(s.base.escalated, s.cand.escalated, n); return phi((PLAN.escalated_max_harm - (s.cand.escalated - s.base.escalated)) / se - Z_975); };
const escBreach = (s, n = perArm) => { const se = rateSe(s.base.escalated, s.cand.escalated, n); return phi(((s.cand.escalated - s.base.escalated) - PLAN.escalated_max_harm) / se - Z_975); };
// Chance that one look fires the 99.9% early stop, at n mature values per arm.
const earlyStop = (s, n) => { const se = rateSe(s.base.escalated, s.cand.escalated, n); return phi(((s.cand.escalated - s.base.escalated) - PLAN.escalated_max_harm) / se - Z_9995); };
// The refund guard: mean of a value that is the refund amount with chance `refunded`, else 0.
const refundVar = (a) => a.refunded * a.refund_usd ** 2 - (a.refunded * a.refund_usd) ** 2;
const refundSe = (s) => Math.sqrt((refundVar(s.base) + refundVar(s.cand)) / perArm);
const refundHarm = (s) => s.cand.refunded * s.cand.refund_usd - s.base.refunded * s.base.refund_usd;
const refundPass = (s) => phi((PLAN.refund_max_harm - refundHarm(s)) / refundSe(s) - Z_975);
const refundBreach = (s) => phi((refundHarm(s) - PLAN.refund_max_harm) / refundSe(s) - Z_975);

// The looks that can fire the early stop. The simulation ticks once a day at 00:00 UTC, so at the look on day L the
// conversations of the first L - lag_days days are mature (a conversation is mature once it is lag_days old). The
// guard needs early_stop_min_per_arm mature values in each arm; with a fair coin an arm has half of each day's
// conversations (one day gives 320, two give 640, so the coin's spread never decides whether a look counts).
export function earlyStopLooks() {
  const looks = [];
  const cutoffDay = PLAN.days + PLAN.lag_days;
  for (let day = 1; day <= cutoffDay; day++) {
    const matureDays = Math.min(PLAN.days, Math.max(0, day - PLAN.lag_days));
    const n = (matureDays * PLAN.per_day) / 2;
    if (n >= PLAN.early_stop_min_per_arm) looks.push({ day, n });
  }
  return looks;
}

// Union bound over the looks: the chance that at least one fires is at most the sum of each one's chance.
const anyEarlyStop = (s) => Math.min(1, earlyStopLooks().reduce((sum, l) => sum + earlyStop(s, l.n), 0));

// How a theory value becomes a limit for `runs` simulated experiments.
//  - SLACK allows for what the theory leaves out: it uses the normal distribution, the pilot uses score and Welch
//    intervals, and the arm sizes vary a little. An upper limit is the theory value times SLACK; a lower limit lets
//    the chance of failing be SLACK times its theory value.
//  - Four standard errors of the simulated rate are added on top, so a correct rule fails by chance less than
//    once in ten thousand runs of the simulation.
//  - TOL is an additive allowance of 2 percentage points for the same approximations. Each limit uses whichever of
//    SLACK and TOL is tighter: SLACK for rates near 0 or 1, TOL in the middle of the range.
//  - A rate that theory puts near zero may still show a handful of events: at most RARE of them.
const SLACK = 1.5;
const TOL = 0.02;
const RARE = 3;
const noise = (p, runs) => 4 * Math.sqrt((p * (1 - p)) / runs);
export const atMost = (p, runs) => { const q = Math.min(1, p * SLACK, p + TOL); return Math.max(q + noise(q, runs), RARE / runs); };
export const atLeast = (p, runs) => { const q = Math.max(0, 1 - (1 - p) * SLACK, p - TOL); return Math.max(0, Math.min(q - noise(q, runs), 1 - RARE / runs)); };

// Every limit, for a simulation of `runs` experiments per scenario. `max` limits bound a rate from above, `min`
// limits from below. Each has the theory value it comes from and one sentence of reasoning.
export function limits(runs) {
  const S = SCENARIOS;
  const out = [];
  const max = (scenario, measure, theory, why) => out.push({ scenario, measure, kind: "max", theory, limit: atMost(theory, runs), why });
  const min = (scenario, measure, theory, why) => out.push({ scenario, measure, kind: "min", theory, limit: atLeast(theory, runs), why });

  max("aa", "keep", primaryClears(S.aa), "With no true difference, keep needs the measured gain to reach min_effect by chance; the guards can only lower this.");
  max("aa", "revert_early", anyEarlyStop(S.aa), "With no true harm, an early stop needs a measured harm far past the margin at some look.");
  max("aa", "revert_final", primaryWorse(S.aa) + escBreach(S.aa), "With no true difference, the final analysis reverts when the primary looks significantly worse (2.5% by design) or a guard looks breached.");

  max("lift_min", "keep", primaryClears(S.lift_min), "A true gain equal to min_effect is measured at or above it half the time; the guards can only lower this (a Known limit in docs/PILOT.md).");

  // Keep needs every condition at once, so the chance of keep is at least 1 minus the sum of each one failing.
  min("lift_double", "keep", 1 - ((1 - primaryClears(S.lift_double)) + (1 - escPass(S.lift_double)) + (1 - refundPass(S.lift_double)) + 0.002), "A true gain of twice min_effect with no harm is kept unless the primary misses, a guard is not shown safe at this size, or an integrity check false-alarms (0.1% each for the split and the missing-value checks).");
  max("lift_double", "revert_early", anyEarlyStop(S.lift_double), "No true harm.");

  max("harm_boundary", "keep", escPass(S.harm_boundary), "A guard whose true harm equals the margin is shown safe only when its whole 95% interval falls inside the margin: 2.5% by design.");
  max("harm_boundary", "revert_early", anyEarlyStop(S.harm_boundary), "At the margin exactly, each look's 99.9% early stop fires with chance 0.05% (one side), summed over the looks that can fire it.");
  max("harm_boundary", "revert_final", escBreach(S.harm_boundary) + primaryWorse(S.harm_boundary), "At the margin exactly, the final analysis calls a breach 2.5% of the time by design.");

  max("harm_double", "keep", escPass(S.harm_double), "A guard whose true harm is twice the margin is almost never shown safe.");
  min("harm_double", "revert", escBreach(S.harm_double), "The final analysis alone finds this breach this often; the early stop can only add to it.");

  max("harm_large", "keep", escPass(S.harm_large), "A large harm is never shown safe.");
  const day6 = earlyStopLooks().find((l) => l.day === 6);
  min("harm_large", "revert_early_by_day_6", earlyStop(S.harm_large, day6.n), "By the look on day 6, four days of conversations are mature, and that look alone fires the early stop this often.");
  min("harm_large", "revert", Math.max(escBreach(S.harm_large), earlyStop(S.harm_large, perArm)), "A large harm ends in revert.");

  max("refund_boundary", "keep", refundPass(S.refund_boundary), "A mean guard whose true harm equals the margin is shown safe only when its whole 95% interval falls inside the margin: 2.5% by design.");
  max("refund_boundary", "revert", refundBreach(S.refund_boundary) + escBreach(S.refund_boundary) + primaryWorse(S.refund_boundary), "At the margin exactly, the final analysis calls a refund breach 2.5% of the time by design; the refund guard has no early stop.");
  max("refund_double", "keep", refundPass(S.refund_double), "A mean guard whose true harm is twice the margin is almost never shown safe.");
  min("refund_double", "revert", refundBreach(S.refund_double), "The final analysis finds this refund breach this often; nothing else reverts it, because the guard has no early stop.");
  max("refund_double", "revert_early", anyEarlyStop(S.refund_double), "The refund guard is not critical and the escalation guard has no true harm, so nothing should stop early.");
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const runs = Number(process.argv[2] ?? 20000);
  console.log(`Limits for ${runs} runs per scenario (theory value, then the limit):`);
  for (const l of limits(runs)) console.log(`${l.scenario.padEnd(14)} ${l.measure.padEnd(22)} ${l.kind}  theory ${l.theory.toExponential(3).padStart(10)}  limit ${l.limit.toFixed(5)}`);
  console.log(`Looks that can fire the early stop: ${earlyStopLooks().map((l) => `day ${l.day} (n ${l.n})`).join(", ")}`);
}
