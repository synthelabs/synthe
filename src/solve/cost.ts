import type { Model, Reply } from "../model/client.ts";
import type { ModelPrices, Problem, SolveCost } from "./types.ts";

// What a run spent on model calls (S02, GOAL-2.md): every call of every kind, proposer and judge, goes through one
// meter per problem. result.json shows the totals, and budget.max_usd stops the run before a call that would pass it.
//
// A call's cost is known only after it: the provider reports its tokens. So "a call that would pass the limit" is
// judged by the most expensive call so far. Calls can run in parallel (the judge asks several questions at once), so
// each call in flight reserves that much until it ends, and the check counts the reservations too. Before any call
// has finished, its cost is unknown: then a second call waits for the first, so parallel calls cannot pass the cap.

export class BudgetError extends Error {}

const dollars = (usd: number) => "$" + usd.toFixed(usd < 1 ? 4 : 2);

export class CostMeter {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  private usd = 0;
  private dearest = 0;
  private reserved = 0;
  private inFlight = 0;
  private finished: (() => void)[] = [];
  private prices: ModelPrices | undefined;
  private maxUsd: number | null;
  constructor(prices: ModelPrices | undefined, maxUsd: number | null) {
    this.prices = prices;
    this.maxUsd = maxUsd;
  }

  private costOf(input: number, output: number): number {
    return this.prices ? (input * this.prices.input_per_mtok + output * this.prices.output_per_mtok) / 1_000_000 : 0;
  }

  // A plain stop reason when the next call would take the known cost above budget.max_usd, else null.
  stopReason(): string | null {
    if (this.maxUsd === null || !this.prices) return null;
    if (this.usd >= this.maxUsd || this.usd + this.reserved + this.dearest > this.maxUsd) {
      return `Reached the cost limit: ${dollars(this.usd)} spent, and the next model call could take it above ${dollars(this.maxUsd)}.`;
    }
    return null;
  }

  // Counts one finished call. Tokens the provider did not report count as 0.
  add(usage: { input: number; output: number } | undefined): void {
    this.calls++;
    const input = usage?.input ?? 0, output = usage?.output ?? 0;
    this.inputTokens += input;
    this.outputTokens += output;
    const cost = this.costOf(input, output);
    this.usd += cost;
    this.dearest = Math.max(this.dearest, cost);
  }

  // usd is null when model calls were made without model.prices; with no calls it is 0.
  summary(): SolveCost {
    const usd = this.prices || this.calls === 0 ? Math.round(this.usd * 1e6) / 1e6 : null;
    return { calls: this.calls, input_tokens: this.inputTokens, output_tokens: this.outputTokens, usd };
  }

  // The client that every model call of the run goes through. A call the budget refuses throws BudgetError and is
  // not counted. A call that fails after it was sent still counts: the provider may have charged for it.
  wrap(model: Model): Model {
    return {
      ask: async (a) => {
        const capped = this.maxUsd !== null && this.prices !== undefined;
        // No finished call yet means no known cost to reserve: wait for the call in flight to end first.
        while (capped && this.calls === 0 && this.inFlight > 0) await new Promise<void>((resolve) => this.finished.push(resolve));
        const why = this.stopReason();
        if (why) throw new BudgetError(why);
        const hold = this.dearest;
        this.reserved += hold;
        this.inFlight++;
        const release = () => {
          this.reserved -= hold;
          this.inFlight--;
          for (const wake of this.finished.splice(0)) wake();
        };
        let reply: Reply;
        try {
          reply = await model.ask(a);
        } catch (e) {
          this.add(undefined);
          release();
          throw e;
        }
        this.add(reply.usage);
        release();
        return reply;
      },
    };
  }
}

// One meter for each problem object, so the proposer, the judge and the loop of one run share it.
const meters = new WeakMap<Problem, CostMeter>();
export function meterFor(problem: Problem): CostMeter {
  let m = meters.get(problem);
  if (!m) {
    m = new CostMeter(problem.model?.prices, problem.budget.max_usd ?? null);
    meters.set(problem, m);
  }
  return m;
}
