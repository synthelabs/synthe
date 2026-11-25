import type { Goal, Scenario } from "../core/goal.ts";
import { paired } from "../core/merge-rule.ts";
import { sumCosts } from "../core/cost.ts";
import type { State, VaultResult } from "../core/state.ts";
import type { Model } from "../model/client.ts";
import { EVEN, TIE, scorer } from "./score.ts";

// The vault: test cases marked "split": "vault", which no round ever reads. Every round's winner is checked on the
// held-back cases, so over a dozen rounds of picking winners the held-back cases slowly get fitted too. The vault
// is looked at only here, once a run is over, so it still says whether the run's gains carry to cases nobody chose
// for. It never merges or reverts anything; it is a reading for a person.
export const vaultCases = (scenarios: Scenario[]): Scenario[] => scenarios.filter((s) => s.split === "vault");

// The prompt now against the prompt the run started from, head to head on the vault cases only, by the same
// replies, judge and checks a round uses. Wins and losses are from the current prompt's side. p is the one-sided
// sign test the held-back check uses. A case the judge or a reply couldn't settle is counted as unknown, not as
// a tie, and left out of the test.
export async function runVault(goal: Goal, startPrompt: string, currentPrompt: string, scenarios: Scenario[], model: Model, random: () => number = Math.random): Promise<Omit<VaultResult, "at" | "round">> {
  const vault = vaultCases(scenarios);
  if (vault.length === 0) return { wins: 0, losses: 0, ties: 0, unknown: 0, p: 1, cases: 0, costUsd: 0 };
  const { costs, challenge, repliesFor } = scorer(goal, model, random);
  const startReplies = await repliesFor(startPrompt, vault);
  const rows = (await challenge("vault", currentPrompt, vault, startReplies)).map((d) => d.row);
  const known = rows.filter((r) => r.score !== null);
  const split = paired(known, known.map((r) => ({ ...r, score: EVEN })));
  return {
    wins: split?.wins ?? 0, losses: split?.losses ?? 0, ties: known.filter((r) => r.score === TIE).length,
    unknown: rows.length - known.length, p: split?.p ?? 1, cases: vault.length, costUsd: sumCosts(costs),
  };
}

const cases = (n: number) => `${n} ${n === 1 ? "case" : "cases"}`;

// One plain line, and a next step when the vault disagrees with the held-back gains. Empty when no vault result
// is in the state. heldBackGained: the run merged changes or its held-back score went up.
export function vaultLines(state: State, heldBackGained: boolean): string[] {
  const v = state.vault;
  if (!v) return [];
  const unknown = v.unknown ? `, ${v.unknown} couldn't be judged` : "";
  const lines = [`Vault check (cases no round ever saw): better in ${v.wins}, worse in ${v.losses}, the same in ${v.ties}${unknown}. That is your prompt after round ${v.round} against the one the run started from, on ${cases(v.cases)}.`];
  if (state.round > v.round) lines.push(`Rounds ran after this check; run \`npx synthe vault\` again for a reading of the current prompt.`);
  if (heldBackGained && v.wins <= v.losses) {
    lines.push(v.losses > v.wins
      ? "The held-back cases improved but the vault got worse, so the run's gains may fit the held-back cases rather than your users. Read the merged changes before you rely on them (`npx synthe undo N` puts back the prompt from before round N), and add fresh held-back cases to your test cases before the next run."
      : "The held-back cases improved but the vault shows no gain, so the run's gains may not carry beyond the cases it was checked on. Add fresh held-back cases before the next run, and more vault cases if you want a clearer reading.");
  }
  return lines;
}
