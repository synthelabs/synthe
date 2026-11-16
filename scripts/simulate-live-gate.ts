// Free and deterministic: runs the real live gate (decide) on seeded daily readings with known true rates, so the
// gate's error rates are measured, not assumed. Each run reads the gate once a day until it leaves "continue".
// Run with: npm run simulate:live
import { pathToFileURL } from "node:url";
import { decide, type Reading, type Verdict } from "../src/live/gate.ts";
import { DEFAULT_RULE, resolveRule, type LiveRule } from "../src/live/rule.ts";

const START = "2026-01-01T00:00:00Z";
const DAY_MS = 86400000;

export interface SimulateOptions {
  runs: number;
  baseRate: number;
  testRate: number;
  unitsPerArmPerDay: number;
  rule: LiveRule;
  seed: number;
  // When true, each day's units split between the arms like a real 50/50 assignment: base gets a normal
  // approximation of Binomial(2n, 0.5), test gets the rest. The split check then has real work to do.
  splitUnits?: boolean;
}

export interface SimulateResult {
  promote: number;
  drop: number;
  invalid: number;
}

// mulberry32: a small seeded generator, so the same seed repeats every run exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller. 1 - u is in (0, 1], so the log never sees 0.
function normal(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Normal approximation of one day's binomial count, rounded and kept from 0 to n.
function dailyEvents(rng: () => number, n: number, rate: number): number {
  const z = normal(rng);
  const events = Math.round(n * rate + z * Math.sqrt(n * rate * (1 - rate)));
  return Math.min(n, Math.max(0, events));
}

// One day's base units out of 2n, from a normal approximation of Binomial(2n, 0.5), rounded and kept in range.
function dailyBaseUnits(rng: () => number, total: number): number {
  const z = normal(rng);
  const base = Math.round(total / 2 + z * Math.sqrt(total / 4));
  return Math.min(total, Math.max(0, base));
}

export function simulate(o: SimulateOptions): SimulateResult {
  const rng = mulberry32(o.seed);
  const n = o.unitsPerArmPerDay;
  const counts = { promote: 0, drop: 0, invalid: 0 };

  for (let run = 0; run < o.runs; run++) {
    const ledger: Reading[] = [];
    let baseUnits = 0;
    let testUnits = 0;
    let baseEvents = 0;
    let testEvents = 0;
    let outcome: Exclude<Verdict["action"], "continue"> = "drop"; // still running after max_days: keep the prompt

    for (let day = 1; day <= o.rule.max_days; day++) {
      let dayBase = n;
      let dayTest = n;
      if (o.splitUnits) {
        dayBase = dailyBaseUnits(rng, 2 * n);
        dayTest = 2 * n - dayBase;
      }
      baseUnits += dayBase;
      testUnits += dayTest;
      baseEvents += dailyEvents(rng, dayBase, o.baseRate);
      testEvents += dailyEvents(rng, dayTest, o.testRate);
      const to = new Date(Date.parse(START) + day * DAY_MS).toISOString();
      ledger.push({
        from: START,
        to,
        read_at: to,
        arms: { base: { units: baseUnits, events: baseEvents }, test: { units: testUnits, events: testEvents } },
      });
      const verdict = decide({
        direction: "higher",
        weights: { base: 50, test: 50 },
        readings: ledger,
        rule: o.rule,
        changed: [],
      });
      if (verdict.action !== "continue") {
        outcome = verdict.action;
        break;
      }
    }
    counts[outcome]++;
  }

  return {
    promote: counts.promote / o.runs,
    drop: counts.drop / o.runs,
    invalid: counts.invalid / o.runs,
  };
}

interface Scenario {
  label: string;
  opts: SimulateOptions;
  measure: keyof SimulateResult;
  limit: string;
  ok: (value: number) => boolean;
}

function scenarios(): Scenario[] {
  const looks = resolveRule({ method: "looks", looks: 4 }).rule;
  return [
    {
      label: "A/A, fixed",
      opts: { runs: 4000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: DEFAULT_RULE, seed: 1 },
      measure: "promote",
      limit: "<= 0.035",
      ok: (p) => p <= 0.035,
    },
    {
      label: "A/A, looks",
      opts: { runs: 4000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: looks, seed: 2 },
      measure: "promote",
      limit: "<= 0.035",
      ok: (p) => p <= 0.035,
    },
    {
      label: "Planted lift, fixed",
      opts: { runs: 2000, baseRate: 0.03, testRate: 0.036, unitsPerArmPerDay: 497, rule: DEFAULT_RULE, seed: 3 },
      measure: "promote",
      limit: "0.76 to 0.84",
      ok: (p) => p >= 0.76 && p <= 0.84,
    },
    {
      label: "Planted loss, fixed",
      opts: { runs: 2000, baseRate: 0.036, testRate: 0.03, unitsPerArmPerDay: 497, rule: DEFAULT_RULE, seed: 4 },
      measure: "promote",
      limit: "<= 0.001",
      ok: (p) => p <= 0.001,
    },
    {
      label: "A/A, split units, srm_p 0.0001",
      opts: { runs: 4000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: DEFAULT_RULE, seed: 5, splitUnits: true },
      measure: "invalid",
      limit: "<= 0.005",
      ok: (v) => v <= 0.005,
    },
    {
      // Reference only: shows what the looser 0.001 would do with split units. No limit.
      label: "A/A, split units, srm_p 0.001",
      opts: { runs: 4000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: resolveRule({ srm_p: 0.001 }).rule, seed: 5, splitUnits: true },
      measure: "invalid",
      limit: "none, printed for reference",
      ok: () => true,
    },
  ];
}

function main(): void {
  let failed = false;
  for (const s of scenarios()) {
    const value = simulate(s.opts)[s.measure];
    const ok = s.ok(value);
    if (!ok) failed = true;
    console.log(`${s.label}: ${s.measure} ${value.toFixed(4)} (limit ${s.limit}) ${ok ? "ok" : "FAIL"}`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
