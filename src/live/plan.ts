import { normalQuantile } from "./stats.ts";

// Units each arm needs to detect a relative lift in a rate, with a two-sided test at alpha and the given power.
// It is a plan, not a result: it says how big the experiment must be before any data is read.
export function unitsPerArm(baseRate: number, relativeLift: number, alpha = 0.05, power = 0.8): number {
  const p1 = baseRate;
  const p2 = baseRate * (1 + relativeLift);
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil((z * z * (p1 * (1 - p1) + p2 * (1 - p2))) / ((p2 - p1) ** 2));
}

// Days for one arm to reach its size, when testShare of the daily units go to that arm.
export function daysNeeded(unitsPerArmNeeded: number, unitsPerDay: number, testShare: number): number {
  return Math.ceil(unitsPerArmNeeded / (unitsPerDay * testShare));
}
