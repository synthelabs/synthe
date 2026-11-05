import type { Goal } from "../core/goal.ts";
import { guardSentence } from "../core/merge-rule.ts";
import { budgetSpend, isFinished, type RoundRecord, type State } from "../core/state.ts";
import { FULL_SHARE_UNTIL, PROXY_AUTH_MESSAGE } from "../core/share.ts";

export const ISSUE_TITLE = "Synthe: prompt report";

// What a round can't tell you, said every time, so an offline win is never mistaken for proof of business results.
export function notTested(goal: Goal): string[] {
  return [
    "**What this did not test**",
    "- Tools or actions your agent takes: only the system prompt was run, with no tools.",
    "- Conversations: each test case is one message, not a back-and-forth.",
    "- Real users: the test cases are simulated, and the generated ones aren't reviewed by a person.",
    "- People's judgment: replies were compared by an AI judge.",
    ...(goal.policy?.trim() ? [] : ["- Your business rules: synthe.json has no `policy`, so the judge only saw what a good answer looks like for each test case."]),
  ];
}

export const exampleText = (e: { input: string; before: string; after: string }) =>
  `**For example,** someone wrote: "${e.input}"\n> **Before:** ${e.before}\n>\n> **After:** ${e.after}`;

const money = (state: State) => (state.spendUnknown ? `over $${budgetSpend(state).toFixed(2)}` : `$${budgetSpend(state).toFixed(2)}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const left = (goal: Goal, state: State) => `up to ${plural(Math.max(0, goal.merge_rule.max_rounds - state.round), "more round")} back to back`;

// A prompt Synthe can't find needs a person, and the report says so instead of blaming the key.
const missing = (r: RoundRecord | undefined) => r?.outcome === "failed" && r.reasons.some((x) => x.startsWith("couldn't find the prompt"));
// A key that stopped working needs a person too; a busy API waits for the hourly backup.
const badKey = (r: RoundRecord | undefined) => r?.outcome === "failed" && r.failure === "key";
const busy = (r: RoundRecord | undefined) => r?.outcome === "failed" && r.failure === "busy";

// The first thing a team reads in the morning: the outcome in one line, then what it means.
// stoppedByTeam: the team ran `npx synthe stop`, which the run state can't know, so a running run reads as paused.
export function headline(goal: Goal, state: State, stoppedByTeam = false): { title: string; summary: string } {
  const merged = state.rounds.filter((r) => r.outcome === "merged").length;
  // The team's own number, from before the first merge to after the latest one, when they set checks.
  const rated = state.rounds.filter((r) => r.outcome === "merged" && r.checks);
  const gain = rated.length ? `Your checks now pass ${rated.at(-1)!.checks!.after}% of the time, up from ${rated[0].checks!.before}%. ` : "";
  const guarded = state.rounds.filter((r) => r.outcome === "merged" && r.guards);
  const guardLine = guarded.length ? `${guardSentence({ before: guarded[0].guards!.before, after: guarded.at(-1)!.guards!.after })} ` : "";
  const spent = `It has spent ${money(state)} of $${goal.budget.max_usd}.`;
  if (state.proposal) {
    return { title: `A better prompt is waiting for your review: #${state.proposal.pr}`, summary: `Merge it to keep the change, or close it to decline. Synthe pauses, spending nothing, until you decide. ${spent}` };
  }
  const last = state.rounds.at(-1);
  if (state.stopped === "credit") return { title: "Stopped: event credit needs attention", summary: last?.plain ?? "Run `npx synthe key`, then `npx synthe restart`." };
  if (!state.stopped && (missing(last) || badKey(last))) {
    return { title: "Synthe needs you to fix something", summary: `${last!.plain} ${spent}` };
  }
  if (!state.stopped && stoppedByTeam) {
    return { title: merged > 0 ? `Stopped by you after ${plural(merged, "merged change")}` : "Stopped by you", summary: `${gain}${guardLine}It ran ${plural(state.round, "round")} before you stopped it. ${spent}` };
  }
  if (!state.stopped) {
    const wait = busy(last) ? /Synthe's proxy|Credit is unavailable/.test(last?.plain ?? "") ? ` ${last!.plain} Synthe tried again; if it stopped, run \`npx synthe restart\`.` : " The last round didn't finish because Anthropic's API was busy; Synthe tried again right away; if it stopped, run `npx synthe restart`." : "";
    return merged > 0
      ? { title: `Your prompt is getting better: ${plural(merged, "change")} merged so far`, summary: `${gain}${guardLine}Synthe is still running: ${left(goal, state)}.${wait} This page updates after each round. ${spent}` }
      : { title: "Synthe is working on your prompt", summary: `${plural(state.round, "round")} so far; ${left(goal, state)}.${wait} This page updates after each round. ${spent}` };
  }
  const why = /no winner$/.test(state.stopped) ? `the last ${goal.merge_rule.stall_rounds} rounds found nothing clearly better`
    : /^budget/.test(state.stopped) ? `it used its $${goal.budget.max_usd} budget` : `it ran all ${goal.merge_rule.max_rounds} rounds`;
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  if (recent.length > 0 && recent.every((r) => r.outcome === "failed")) {
    // Blame what really failed: the latest round's cause, not always the key's credit.
    const end = recent.at(-1)!;
    if (busy(end) && /Synthe's proxy|Credit is unavailable/.test(end.plain ?? "")) return { title: "Stopped: Synthe's proxy needs attention", summary: end.plain! };
    if (missing(end)) return { title: "Stopped: the last rounds didn't finish", summary: end.plain! };
    if (badKey(end)) return { title: end.plain === PROXY_AUTH_MESSAGE ? "Stopped: the Synthe proxy couldn't verify this run" : "Stopped: your Synthe key stopped working", summary: `${end.plain} ${spent}` };
    if (busy(end) && isFinished(state.stopped)) {
      return { title: "Stopped: the last rounds didn't finish because Anthropic's API was busy", summary: `Nothing is wrong on your side. Synthe stopped because ${why}. It spent ${money(state)} of $${goal.budget.max_usd}.` };
    }
    if (!busy(end)) return { title: "Stopped: the last rounds didn't finish", summary: "Look at the latest run in the Actions tab for the error. If it mentions your key or credit, run `npx synthe key`." };
  }
  if (!isFinished(state.stopped)) return { title: "Stopped: Synthe needs you to fix something", summary: `${state.stopped[0].toUpperCase()}${state.stopped.slice(1)}.` };
  return merged > 0
    ? { title: `Done: your prompt got better overnight (${plural(merged, "change")} merged)`, summary: `${gain}${guardLine}Synthe stopped because ${why}. Nothing more will run or change. It spent ${money(state)} of $${goal.budget.max_usd}.` }
    : { title: "Done: no change was clearly better, so your prompt stays as it was", summary: `Synthe stopped because ${why}. Nothing more will run or change. It spent ${money(state)} of $${goal.budget.max_usd}.` };
}

function nextSteps(goal: Goal, state: State): string[] {
  const merged = state.rounds.some((r) => r.outcome === "merged" || r.outcome === "reverted");
  const steps: string[] = [];
  if (state.proposal) steps.push(`Review #${state.proposal.pr}: merge it to keep the change, or close it to decline.`);
  if (merged) steps.push("Pull the latest changes before you edit your prompt, so Synthe's changes aren't overwritten.");
  const last = state.rounds.at(-1);
  // Before the steps for starting again, which would only fail on the same key.
  if (state.stopped === "credit") steps.push("To use your own Anthropic key, run `npx synthe key`, then `npx synthe restart`.");
  else if (state.stopped && /^budget/.test(state.stopped)) steps.push(`${state.ownKeyFromUsd === undefined ? "Run `npx synthe key` for a fresh own-key budget, or raise" : "Raise"} budget.max_usd in synthe.json and push it, then run \`npx synthe restart\`.`);
  else if (state.stopped && badKey(last)) steps.push(`${last!.plain} Then run \`npx synthe restart\` to start Synthe again.`);
  else if (state.stopped && !state.proposal && !isFinished(state.stopped) && !state.spendUnknown) steps.push("Once you've fixed it, run `npx synthe restart` to start Synthe again.");
  if (state.stopped && /no winner$/.test(state.stopped)) {
    steps.push(`If you want Synthe to keep going, add test cases your agent still gets wrong to \`${goal.scenarios}\` and push, then run \`npx synthe restart\`${state.round < goal.merge_rule.max_rounds ? "" : " (raise `merge_rule.max_rounds` in `synthe.json` first)"}. One line per case, for example:\n  \`{"id": "s99", "input": "Can I return shoes I wore once?", "expected": "Explains worn items can't be returned and offers an exchange if they're faulty", "split": "train"}\`\n  \`expected\` describes a good answer in a sentence. \`split\` is \`train\` (Synthe learns from it) or \`holdout\` (kept hidden to check its changes).`);
  }
  if (!state.stopped && !state.proposal && missing(last)) {
    steps.push(`${last!.plain} Once it's fixed, run \`npx synthe restart\`. Until then Synthe spends nothing.`);
  } else if (!state.stopped && !state.proposal && badKey(last)) {
    steps.push(`${last!.plain} Run \`npx synthe restart\` after ${last!.plain === PROXY_AUTH_MESSAGE ? "that" : "replacing the key"}.`);
  } else if (!state.stopped && !state.proposal) {
    steps.push(busy(last)
      ? /Synthe's proxy|Credit is unavailable/.test(last?.plain ?? "") ? `${last!.plain} Synthe tried again; if it has stopped, run \`npx synthe restart\`.` : "Nothing to do. Anthropic's API was busy during the last round, so Synthe tried again; if it has stopped, run `npx synthe restart`. Otherwise Synthe stops by itself."
      : "Nothing to do. Completed rounds start back to back and Synthe stops by itself.");
    steps.push("To keep your agent unchanged, for example before a demo, run `npx synthe stop`.");
  } else if (state.proposal) {
    steps.push("To stop Synthe completely: `npx synthe stop`.");
  }
  if (state.stopped && !state.proposal) steps.push("When you're done with Synthe: run `npx synthe stop`, delete `synthe.json`, `.synthe/` and `.github/workflows/synthe.yml`, and delete the `SYNTHE_ANTHROPIC_KEY`, `SYNTHE_EVENT_CODE` and `SYNTHE_TEAM_CODE` secrets in your repo's settings.");
  return steps;
}

const TRIED_GROUPS = ["not clearly better", "did not hold on the hidden test cases", "broke a rule or a guard"] as const;

// Which of the three plain reasons a tried change's outcome belongs to. Outcomes that aren't a
// judgement on a scored change (it merged, it was never tested, its edit couldn't be applied) don't count.
function triedGroup(outcome: string): (typeof TRIED_GROUPS)[number] | null {
  if (outcome === "Merged." || outcome === "Not tested." || outcome.startsWith("Not used:")) return null;
  if (outcome.startsWith("Broke one of your rules") || outcome.startsWith("Refused by a safety check") || outcome.includes("guards")) return "broke a rule or a guard";
  if (outcome.includes("hidden")) return "did not hold on the hidden test cases";
  return "not clearly better";
}

// Why a run that found no winner stopped, in the team's own numbers: which checks replies failed most,
// what became of the changes Synthe tried, and what Synthe needs from the team. Shown when the run
// stopped because the last rounds found no winner, and when the budget ran out. Other stops keep the
// report they already had.
export function noWinSection(goal: Goal, state: State): string[] {
  if (!state.stopped || state.proposal) return [];
  const budget = /^budget/.test(state.stopped);
  if (!budget && !/no winner$/.test(state.stopped)) return [];
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);

  // What failed most, from the per-round failure counts the decide step keeps. State written before
  // those counts existed has none; the last scored round's lessons are the fallback, and when there
  // are neither, the section says so instead of guessing.
  const counts = new Map<string, number>();
  for (const r of recent) for (const [check, n] of Object.entries(r.failedChecks ?? {})) counts.set(check, (counts.get(check) ?? 0) + n);
  if (!counts.size && state.lessons) for (const row of state.lessons.rows) for (const check of row.failedChecks ?? []) counts.set(check, (counts.get(check) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);

  const groups = new Map<string, number>();
  for (const r of recent) for (const t of r.tried ?? []) {
    const g = triedGroup(t.outcome);
    if (g) groups.set(g, (groups.get(g) ?? 0) + 1);
  }

  const asks: string[] = [];
  if (top.length) asks.push(`Add test cases your agent still gets wrong, especially ones where replies fail "${top[0][0]}", to \`${goal.scenarios}\` and push. The format is under "What to do next" below.`);
  const weak = (state.calibration ?? []).find((c) => c.reading === "disagrees with you" || c.reading === "unsure");
  if (weak) asks.push(weak.reading === "disagrees with you"
    ? `Rewrite the check "${weak.check}" in plainer words. When the team marked replies by hand with \`npx synthe calibrate\`, the AI marked them differently from the team, so the check may not say what you mean.`
    : `Rewrite the check "${weak.check}" in plainer words. When the team marked replies by hand with \`npx synthe calibrate\`, the AI's marking was unsure against the team's, so the check may be hard to mark either way.`);
  if (budget) asks.push(`Raise \`budget.max_usd\` in \`synthe.json\` if you want more rounds: Synthe stopped when the spend reached the $${goal.budget.max_usd} budget.`);

  const lines = ["### Why there was no win", ""];
  if (top.length) {
    lines.push(`**What failed most** in the last ${plural(recent.length, "round")}:`, ...top.map(([check, n]) => `- "${check}" failed in ${n} ${n === 1 ? "reply" : "replies"}, counting every reply Synthe scored.`), "");
  }
  const grouped = TRIED_GROUPS.filter((g) => groups.has(g));
  if (grouped.length) {
    lines.push("**What the changes Synthe tried did:**", ...grouped.map((g) => `- ${g[0].toUpperCase()}${g.slice(1)}: ${plural(groups.get(g)!, "change")}.`), "");
  }
  if (!top.length && !grouped.length) {
    lines.push("Synthe doesn't have per-check failure counts for these rounds, so it can't say which checks failed most or group the changes it tried.", "");
  }
  if (asks.length) lines.push("**What Synthe needs from you:**", ...asks.map((a) => `- ${a}`), "");
  return lines;
}

// The round on its Actions run page: the outcome, what was tried, the cost and where the full report is.
// The round's attack line, when the repo has a frozen attack set: how many of the attack messages the prompt
// that ended the round held, naming the ones it failed.
export function attackLine(r: RoundRecord): string | null {
  if (!r.attacks) return null;
  if (r.attacks.unknown) return "Attacks: couldn't be checked this round.";
  const held = r.attacks.total - r.attacks.failed.length;
  return r.attacks.failed.length ? `Attacks: ${held} of ${r.attacks.total} held (failed: ${r.attacks.failed.join(", ")}).` : `Attacks: ${held} of ${r.attacks.total} held.`;
}

export function roundSummary(goal: Goal, state: State, record: RoundRecord | null, repo: string): string {
  const { title, summary } = headline(goal, state);
  const report = state.issue ? `Full report: https://github.com/${repo}/issues/${state.issue}` : "";
  if (!record) return [`## Synthe: ${title}`, "", summary, "", report, ""].join("\n");
  const cost = record.costUsd === null ? "unknown" : `$${record.costUsd.toFixed(2)}`;
  const tried = record.tried?.length ? record.tried.map((t) => `- ${t.summary} *${t.outcome}*`) : [];
  const attacks = attackLine(record);
  return [
    `## Synthe round ${record.round}: ${OUTCOME[record.outcome].toLowerCase()}${record.pr ? ` (#${record.pr})` : ""}`, "",
    ...(record.plain ? [record.plain, ""] : []),
    ...(attacks ? [attacks, ""] : []),
    ...(tried.length ? ["What Synthe tried:", ...tried, ""] : []),
    `Cost of this round: ${cost}. ${summary}`, "", report, "",
  ].join("\n");
}

const OUTCOME: Record<RoundRecord["outcome"], string> = { merged: "Merged", reverted: "Undone", proposed: "Waiting for review", declined: "Declined by you", skipped: "No change", failed: "Didn't finish" };

function roundRow(r: RoundRecord): string {
  const result = OUTCOME[r.outcome];
  const tried = r.tried?.length
    ? r.tried.map((t) => `${t.summary} <i>${t.outcome}</i>`).join("<br>")
    : r.plain ?? r.reasons.join("; ");
  const cost = r.costUsd === null ? "unknown" : `$${r.costUsd.toFixed(2)}`;
  return `| ${r.round} | ${result}${r.pr ? ` (#${r.pr})` : ""} | ${tried.replaceAll("|", "/").replaceAll("\n", " ")} | ${cost} |`;
}

export function renderReport(goal: Goal, state: State, now: Date = new Date()): string {
  const { title, summary } = headline(goal, state);
  const changes = state.rounds.filter((r) => ["merged", "reverted", "proposed"].includes(r.outcome) && r.pr);
  const mode = goal.merge_rule.mode === "propose"
    ? "**Mode:** review. Each change waits in a pull request until you merge or close it."
    : "**Mode:** automatic. Changes are merged into your main branch as soon as they win.";
  const lines = [`## ${title}`, "", summary, "", mode, ""];
  if (changes.length) {
    lines.push("### What changed", "");
    for (const r of changes) {
      const undo = r.outcome === "merged" ? ` To undo it, click **Revert** on #${r.pr}.` : "";
      const note = r.outcome === "proposed" ? " (waiting for your review)" : r.outcome === "reverted" ? " (an undo)" : "";
      const label = r.title ? `**#${r.pr}${note}: ${r.title[0].toUpperCase()}${r.title.slice(1)}.**` : `**#${r.pr}${note}:**`;
      const check = r.unverified?.length ? ` **Check these are real:** ${r.unverified.map((d) => `\`${d}\``).join(", ")} ${r.unverified.length === 1 ? "isn't" : "aren't"} in your old prompt or policy.` : "";
      lines.push(`- ${label} ${(r.changed ?? "A change to the prompt").replace(/[.\s]+$/, "")}. ${r.plain ?? ""}${check}${undo}`);
      if (r.example) lines.push("", exampleText(r.example).split("\n").map((l) => `  ${l}`).join("\n"), "");
    }
    lines.push("");
  }
  lines.push(...noWinSection(goal, state));
  lines.push("### What to do next", "", ...nextSteps(goal, state).map((s) => `- ${s}`), "");
  if (state.rounds.length) {
    lines.push(
      "<details><summary>Round by round: every change Synthe tried and what happened</summary>", "",
      "| Round | Result | What Synthe tried | Cost |", "| --- | --- | --- | --- |",
      ...[...state.rounds].reverse().map(roundRow),
      "", "</details>", "",
    );
  }
  lines.push(
    "<details><summary>Details for reviewers</summary>", "",
    `- Goal: ${goal.objective}`,
    `- Rounds: ${state.round} of up to ${goal.merge_rule.max_rounds}. Spent ${money(state)} of $${goal.budget.max_usd}.`,
    goal.share === "none" || !goal.share ? "- Sharing with Synthe: off." :
      goal.share === "full" && now.getTime() < Date.parse(FULL_SHARE_UNTIL)
        ? '- Sharing with Synthe: everything for Crimson Hacks (prompt and test cases until November 9), then numbers and what changed. Turn it off with "share": "none" in synthe.json.'
        : `- Sharing with Synthe: ${goal.share === "numbers" ? "numbers only" : "numbers and what changed"}. Turn it off with "share": "none" in synthe.json.`,
    `- AI models: writer ${goal.models.writer}, agent ${goal.models.runner}, judge ${goal.models.judge}, rule checker ${goal.models.checker}.`,
    "- How Synthe decides: a change merges only when its replies are better in clearly more test cases than they are worse (more than luck would explain), better again on the hidden test cases, and it breaks none of your rules where your old prompt followed them. The judge's numbers below score each test case 100 when the change's reply is better, 0 when worse and 50 when the same, so 50 is even and 52 is the bar.",
    ...(state.rounds.some((r) => r.attacks) ? ["- Attacks: each round, the current prompt and the winning change also answer the frozen attack messages in `.synthe/attacks.jsonl`, and a change that fails one the current prompt passes isn't merged. Attacks are a basic check, not a security test."] : []),
    ...[...state.rounds].reverse().map((r) => `- Round ${r.round}: ${OUTCOME[r.outcome].toLowerCase()}, cost ${r.costUsd === null ? "unknown" : `$${r.costUsd.toFixed(2)}`}${typeof r.writeUsd === "number" ? ` (writing $${r.writeUsd.toFixed(2)})` : ""}.${attackLine(r) ? ` ${attackLine(r)}` : ""} ${r.reasons.join("; ").replaceAll("\n", " ").replace(/candidate-(\d+)/g, "change $1")}`),
    "", "</details>", "",
    ...notTested(goal), "",
    "Only your prompt file can change. Was this useful? React 👍 or 👎 on this issue to tell us.",
  );
  return lines.join("\n");
}
