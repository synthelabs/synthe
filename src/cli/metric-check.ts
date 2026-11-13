import type { Exec } from "../improve/exec.ts";
import { daysNeeded, unitsPerArm } from "../live/plan.ts";
import { DEFAULT_RULE } from "../live/rule.ts";
import { commandSource } from "../metric/command.ts";

// Reads the team's metric for each of the last N whole UTC days and says how long an experiment would take.
// It only reads: nothing is written and no model is called.
const DAY_MS = 86_400_000;
const USAGE = 'Usage: npx synthe metric check --run "<command>" [--days 14] [--agent default]';
const LIFTS = [0.1, 0.2, 0.5];

type Parsed = { run: string; days: number; agent: string } | { error: string };

function parse(args: string[]): Parsed {
  if (args[0] !== "check") return { error: USAGE };
  let run: string | undefined;
  let days = 14;
  let agent = "default";
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: USAGE };
    if (flag === "--run") run = value;
    else if (flag === "--days") {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n < 1 || n > 90) return { error: "--days must be a whole number from 1 to 90." };
      days = n;
    } else if (flag === "--agent") agent = value;
    else return { error: USAGE };
  }
  if (!run) return { error: USAGE };
  return { run, days, agent };
}

const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const count = (n: number) => Math.round(n).toLocaleString("en-US");

export async function metricCheck(
  io: { say(t: string): void; exec: Exec },
  cwd: string,
  args: string[],
  now = new Date(),
): Promise<boolean> {
  const parsed = parse(args);
  if ("error" in parsed) {
    io.say(parsed.error);
    return false;
  }

  const source = commandSource(io.exec, cwd, parsed.run);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: { date: string; units: number; events: number }[] = [];
  // Oldest first, so the lines read in time order.
  for (let i = parsed.days; i >= 1; i--) {
    const start = midnight - i * DAY_MS;
    const res = await source.read({
      agent: parsed.agent,
      from: new Date(start).toISOString(),
      to: new Date(start + DAY_MS).toISOString(),
      arms: ["base"],
    });
    if ("problem" in res) {
      io.say(res.problem);
      return false;
    }
    const base = res.arms.base;
    if ("sum" in base) {
      io.say("The metric check reads rate metrics (events and units) only.");
      return false;
    }
    days.push({ date: new Date(start).toISOString().slice(0, 10), units: base.units, events: base.events });
  }

  const totalUnits = days.reduce((s, d) => s + d.units, 0);
  const totalEvents = days.reduce((s, d) => s + d.events, 0);
  if (totalUnits === 0) {
    io.say(`No data for this agent in the last ${parsed.days} days. Check the command and the agent name.`);
    return false;
  }

  for (const d of days) {
    io.say(d.units > 0 ? `${d.date}  ${pct(d.events / d.units)}  ${count(d.units)} units` : `${d.date}  no data  0 units`);
  }

  const withData = days.filter((d) => d.units > 0);
  const rate = (d: { units: number; events: number }) => d.events / d.units;
  const lowest = withData.reduce((a, b) => (rate(b) < rate(a) ? b : a));
  const highest = withData.reduce((a, b) => (rate(b) > rate(a) ? b : a));
  const baseRate = totalEvents / totalUnits;
  const unitsPerDay = totalUnits / parsed.days;

  io.say("");
  io.say(`Mean rate: ${pct(baseRate)} (${count(totalEvents)} events in ${count(totalUnits)} units over ${parsed.days} days)`);
  io.say(`Lowest day: ${lowest.date} ${pct(rate(lowest))}`);
  io.say(`Highest day: ${highest.date} ${pct(rate(highest))}`);
  io.say(`Units per day: ${count(unitsPerDay)}`);

  if (!(baseRate > 0 && baseRate < 1)) {
    io.say(`The table cannot be computed for a rate of ${pct(baseRate)}: it needs a rate above 0% and below 100%.`);
    return false;
  }

  io.say("");
  io.say("Days needed at a 50/50 split:");
  for (const lift of LIFTS) {
    const label = `${Math.round(lift * 100)}% lift`;
    if (baseRate * (1 + lift) >= 1) {
      io.say(`${label}: cannot be computed, the lift takes the rate to 100% or more.`);
      continue;
    }
    const n = unitsPerArm(baseRate, lift);
    const days = Math.max(DEFAULT_RULE.min_days, daysNeeded(n, unitsPerDay, 0.5));
    io.say(`${label}: ${days} days (${count(n)} units per arm)`);
  }

  io.say("");
  io.say("Nothing was changed and nothing was spent. Next, pick the smallest lift you would act on and plan the test for the days in its row.");
  return true;
}
