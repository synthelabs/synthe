// The live gate: readings in, one verdict out. It decides whether a changed prompt is promoted, so the order
// of checks below matters. The first check that matches wins, and a promotion is only ever made at a look.

import { type LiveRule } from "./rule.ts";
import { interval, meanTest, rateTest, srmP, type Test } from "./stats.ts";

export type ArmData = { units: number; events: number } | { units: number; sum: number; sum_sq: number };

// Cumulative from the experiment's start: each reading reads the whole window again.
export interface Reading {
  from: string;
  to: string;
  read_at: string;
  arms: { base: ArmData; test: ArmData; hold?: ArmData };
}

export interface GuardReading {
  name: string;
  direction: "higher" | "lower";
  max_worse: number;
  base: ArmData;
  test: ArmData;
}

export interface GateInput {
  direction: "higher" | "lower";
  weights: { base: number; test: number };
  readings: Reading[];
  guards?: GuardReading[];
  rule: LiveRule;
  changed: string[];
}

export type Reason = "no_data" | "guard" | "split" | "too_early" | "running" | "win" | "no_difference" | "worse";

export interface Verdict {
  action: "promote" | "drop" | "continue" | "invalid";
  reason: Reason;
  guard?: string;
  test?: Test;
  interval?: [number, number];
  days: number;
  look?: number;
  changed: string[];
}

const DAY_MS = 86400000;

function isRate(arm: ArmData): arm is { units: number; events: number } {
  return "events" in arm;
}

// Every number in an arm must be a real count in its range, so a bad value never reaches a test.
function armUsable(arm: ArmData): boolean {
  if (!Number.isFinite(arm.units) || arm.units <= 0) return false;
  if (isRate(arm)) return Number.isFinite(arm.events) && arm.events >= 0 && arm.events <= arm.units;
  return Number.isFinite(arm.sum) && Number.isFinite(arm.sum_sq) && arm.sum_sq >= 0;
}

// The point estimate of an arm: a rate is events per unit, a mean is the sum per unit.
function pointOf(arm: ArmData): number {
  return isRate(arm) ? arm.events / arm.units : arm.sum / arm.units;
}

// Whole days from the first reading's start to this reading's end.
function daysAt(readings: Reading[], index: number): number {
  return Math.floor((Date.parse(readings[index].to) - Date.parse(readings[0].from)) / DAY_MS);
}

// Every reading must have readable dates, and the window end must never move back. A copy error like that
// would make the look count wrong, so the whole ledger fails closed.
function ledgerIsSound(readings: Reading[]): boolean {
  let previousEnd = -Infinity;
  for (const r of readings) {
    const start = Date.parse(r.from);
    const end = Date.parse(r.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < previousEnd) return false;
    previousEnd = end;
  }
  return true;
}

// How many looks are due at this many days. Integer comparison, so no float rounding moves a look.
function looksDue(days: number, rule: LiveRule): number {
  let due = 0;
  while (due < rule.looks && days * rule.looks >= rule.max_days * (due + 1)) due++;
  return due;
}

function testOf(base: ArmData, test: ArmData): Test | null {
  if (isRate(base) && isRate(test)) return rateTest(base, test);
  if (!isRate(base) && !isRate(test)) return meanTest(base, test);
  return null;
}

// Step 1 for one pair of arms: an empty, bad or mixed pair is no data. Fail closed.
function noData(base: ArmData, test: ArmData): boolean {
  return !armUsable(base) || !armUsable(test) || isRate(base) !== isRate(test);
}

// Step 3: the arms must have the share they were set to. A null result means bad weights, so it fails closed.
// A NaN p fails too, which is why this is written as "not at least srm_p".
function splitBroken(base: ArmData, test: ArmData, input: GateInput): boolean {
  const rule = input.rule;
  if (rule.srm_p > 0) {
    const p = srmP([base.units, test.units], [input.weights.base, input.weights.test]);
    return p === null || !(p >= rule.srm_p);
  }
  return false;
}

// Step 4: not enough days, units or (for rates) events in an arm.
function tooEarly(base: ArmData, test: ArmData, days: number, rule: LiveRule): boolean {
  const enoughEvents = (arm: ArmData) => !isRate(arm) || arm.events >= rule.min_events_per_arm;
  if (days < rule.min_days || base.units < rule.min_units_per_arm || test.units < rule.min_units_per_arm) return true;
  return !enoughEvents(base) || !enoughEvents(test);
}

export function decide(input: GateInput): Verdict {
  const { rule, changed, readings } = input;
  const last = readings[readings.length - 1];
  const ledgerOk = ledgerIsSound(readings);
  const days = last && ledgerOk ? daysAt(readings, readings.length - 1) : 0;
  const out = (action: Verdict["action"], reason: Reason, extra: Partial<Verdict> = {}): Verdict => ({
    action,
    reason,
    days,
    changed: [...changed],
    ...extra,
  });

  // 1. No data: no reading, a broken ledger, or a bad or empty arm.
  if (!last || !ledgerOk) return out("continue", "no_data");
  const { base, test } = last.arms;
  if (noData(base, test)) return out("continue", "no_data");

  // 2. Guards: a breach of a guard drops at once. Points are compared in the guard metric's own units.
  for (const guard of input.guards ?? []) {
    if (guard.base.units <= 0 || guard.test.units <= 0) continue;
    if (guard.base.units < rule.min_units_per_arm || guard.test.units < rule.min_units_per_arm) continue;
    const worse =
      guard.direction === "lower"
        ? pointOf(guard.test) - pointOf(guard.base)
        : pointOf(guard.base) - pointOf(guard.test);
    if (worse > guard.max_worse) return out("drop", "guard", { guard: guard.name });
  }

  // 3. Split.
  if (splitBroken(base, test, input)) return out("invalid", "split");

  // 4. Too early.
  if (tooEarly(base, test, days, rule)) return out("continue", "too_early");

  // 5-6. Looks. A look is taken once, at the first reading where it is due and where the numbers were usable.
  const final = rule.method === "looks" ? rule.looks : 1;
  const dueAt = (d: number) => (rule.method === "looks" ? looksDue(d, rule) : d >= rule.max_days ? 1 : 0);
  const now = dueAt(days);
  // The look ledger: the largest look due at an earlier reading that passes steps 1, 3 and 4 on its own
  // numbers. Guards are not replayed for earlier readings; they are a check on the latest numbers only.
  let taken = 0;
  for (let j = 0; j < readings.length - 1; j++) {
    const earlier = readings[j].arms;
    const d = daysAt(readings, j);
    if (noData(earlier.base, earlier.test)) continue;
    if (splitBroken(earlier.base, earlier.test, input)) continue;
    if (tooEarly(earlier.base, earlier.test, d, rule)) continue;
    taken = Math.max(taken, dueAt(d));
  }
  const lookLimit = rule.method === "looks" ? rule.alpha / rule.looks : rule.alpha;
  const takesLook = now > taken;
  const limit = takesLook ? lookLimit : rule.alpha;
  const t = testOf(base, test);
  const extra: Partial<Verdict> = {
    ...(rule.method === "looks" && now >= 1 ? { look: now } : {}),
    ...(t ? { test: t, interval: interval(t, lookLimit) } : {}),
  };

  if (now === 0) return out("continue", "running", extra);
  if (!takesLook && now < final) return out("continue", "running", extra);

  // 7. A win is p below the limit in the good direction. A promotion needs a look taken at this reading.
  const diff = t ? t.diff : 0;
  const good = input.direction === "higher" ? diff > 0 : diff < 0;
  const bad = input.direction === "higher" ? diff < 0 : diff > 0;
  if (takesLook && t && t.p < limit && good) return out("promote", "win", extra);

  if (takesLook && now < final) return out("continue", "running", extra);

  // The end has passed: no promotion, ever. A bad result that is clear is dropped as worse; a tie or a
  // small difference keeps the current prompt.
  if (t && bad && t.p < rule.alpha) return out("drop", "worse", extra);
  return out("drop", "no_difference", extra);
}
