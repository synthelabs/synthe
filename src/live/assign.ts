import { createHash } from "node:crypto";

// Shipped clients hash units with this rule, so the same person lands in the same arm everywhere.
// Changing the hash, the modulus or the range rule would move people between arms mid-test.
// A change needs a new rule name (design plan, section 11). Never edit this in place.
export const ASSIGN_RULE = "sha256-v1";

export interface Arm {
  id: string;
  weight: number;
}

// Maps a unit (for example a conversation id) to a bucket from 0 to 9999. The salt is per experiment,
// so the same unit gets a fresh draw in each one.
// A lone surrogate is rejected: Node would hash it as U+FFFD, but Python raises, so the ports would disagree.
export function bucket(unitId: string, salt: string): number {
  // Other types would stringify differently in each port (null, 100.0, objects), so they are refused here.
  if (typeof unitId !== "string" || typeof salt !== "string") {
    throw new TypeError("bucket: the unit id and the salt must be text.");
  }
  if (/\p{Cs}/u.test(unitId) || /\p{Cs}/u.test(salt)) {
    throw new Error("bucket: the unit id and the salt must be valid Unicode text.");
  }
  const hex = createHash("sha256").update(`${salt}:${unitId}`, "utf8").digest("hex");
  return parseInt(hex.slice(0, 8), 16) % 10000;
}

// Arms take consecutive ranges of the 10000 buckets, in the order given, sized by weight. Weights need not
// add up to 100: the ranges scale to whatever the total is.
//
// The walk is integer-only, so every language gets the same answer. Whole weights capped at 1,000,000 keep
// every product below 2^53, where doubles and integers agree exactly; a fraction would round differently per port.
export function pickArm(arms: Arm[], unitId: string, salt: string): string {
  for (const arm of arms) {
    if (!Number.isInteger(arm.weight) || arm.weight < 0) {
      throw new Error(`Arm "${arm.id}": weight must be 0 or more and a whole number.`);
    }
  }
  const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
  if (!(total > 0)) throw new Error("Give at least one arm with a weight above 0.");
  if (total > 1000000) throw new Error("Arm weights must add up to 1,000,000 or less.");

  const x = bucket(unitId, salt) * total;
  let cum = 0;
  let last: string | undefined;
  for (const arm of arms) {
    if (arm.weight === 0) continue;
    cum += arm.weight;
    last = arm.id;
    // A bucket exactly on an edge (x equal to cum * 10000) belongs to the next arm.
    if (x < cum * 10000) return arm.id;
  }
  // Unreachable: x is at most 9999 * total, below total * 10000, where the last arm with weight above 0 ends. Kept so the function
  // never falls through to undefined.
  return last as string;
}
