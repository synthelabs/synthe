import type { Goal } from "../core/goal.ts";
import { isFinished, type RoundRecord, type State } from "../core/state.ts";

export const ISSUE_TITLE = "Synthe: overnight prompt report";

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

const money = (state: State) => (state.spendUnknown ? `over $${state.spendUsd.toFixed(2)}` : `$${state.spendUsd.toFixed(2)}`);
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
  const spent = `It has spent ${money(state)} of $${goal.budget.max_usd}.`;
  if (state.proposal) {
    return { title: `A better prompt is waiting for your review: #${state.proposal.pr}`, summary: `Merge it to keep the change, or close it to decline. Synthe pauses, spending nothing, until you decide. ${spent}` };
  }
  const last = state.rounds.at(-1);
  if (!state.stopped && (missing(last) || badKey(last))) {
    return { title: "Synthe needs you to fix something", summary: `${last!.plain} ${spent}` };
  }
  if (!state.stopped && stoppedByTeam) {
    return { title: merged > 0 ? `Stopped by you after ${plural(merged, "merged change")}` : "Stopped by you", summary: `${gain}It ran ${plural(state.round, "round")} before you stopped it. ${spent}` };
  }
  if (!state.stopped) {
    const wait = busy(last) ? " The last round didn't finish because Anthropic's API was busy; Synthe tried again right away; if it stopped, run `npx synthe restart`." : "";
    return merged > 0
      ? { title: `Your prompt is getting better: ${plural(merged, "change")} merged so far`, summary: `${gain}Synthe is still running: ${left(goal, state)}.${wait} This page updates after each round. ${spent}` }
      : { title: "Synthe is working on your prompt", summary: `${plural(state.round, "round")} so far; ${left(goal, state)}.${wait} This page updates after each round. ${spent}` };
  }
  const why = /no winner$/.test(state.stopped) ? `the last ${goal.merge_rule.stall_rounds} rounds found nothing clearly better`
    : /^budget/.test(state.stopped) ? `it used its $${goal.budget.max_usd} budget` : `it ran all ${goal.merge_rule.max_rounds} rounds`;
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  if (recent.length > 0 && recent.every((r) => r.outcome === "failed")) {
    // Blame what really failed: the latest round's cause, not always the key's credit.
    const end = recent.at(-1)!;
    if (missing(end)) return { title: "Stopped: the last rounds didn't finish", summary: end.plain! };
    if (badKey(end)) return { title: "Stopped: your Synthe key stopped working", summary: `${end.plain} ${spent}` };
    if (busy(end) && isFinished(state.stopped)) {
      return { title: "Stopped: the last rounds didn't finish because Anthropic's API was busy", summary: `Nothing is wrong on your side. Synthe stopped because ${why}. It spent ${money(state)} of $${goal.budget.max_usd}.` };
    }
    if (!busy(end)) return { title: "Stopped: the last rounds didn't finish", summary: "Look at the latest run in the Actions tab for the error. If it mentions your key or credit, get a new key from the Synthe table." };
  }
  if (!isFinished(state.stopped)) return { title: "Stopped: Synthe needs you to fix something", summary: `${state.stopped[0].toUpperCase()}${state.stopped.slice(1)}.` };
  return merged > 0
    ? { title: `Done: your prompt got better overnight (${plural(merged, "change")} merged)`, summary: `${gain}Synthe stopped because ${why}. Nothing more will run or change. It spent ${money(state)} of $${goal.budget.max_usd}.` }
    : { title: "Done: no change was clearly better, so your prompt stays as it was", summary: `Synthe stopped because ${why}. Nothing more will run or change. It spent ${money(state)} of $${goal.budget.max_usd}.` };
}

function nextSteps(goal: Goal, state: State): string[] {
  const merged = state.rounds.some((r) => r.outcome === "merged" || r.outcome === "reverted");
  const steps: string[] = [];
  if (state.proposal) steps.push(`Review #${state.proposal.pr}: merge it to keep the change, or close it to decline.`);
  if (merged) steps.push("Pull the latest changes before you edit your prompt, so Synthe's changes aren't overwritten.");
  const last = state.rounds.at(-1);
  // Before the steps for starting again, which would only fail on the same key.
  if (state.stopped && badKey(last)) steps.push(`${last!.plain} Then run \`npx synthe restart\` to start Synthe again.`);
  else if (state.stopped && !state.proposal && !isFinished(state.stopped) && !state.spendUnknown) steps.push("Once you've fixed it, run `npx synthe restart` to start Synthe again.");
  if (state.stopped && /no winner$/.test(state.stopped)) {
    steps.push(`If you want Synthe to keep going, add test cases your agent still gets wrong to \`${goal.scenarios}\` and push, then run \`npx synthe restart\`${state.round < goal.merge_rule.max_rounds ? "" : " (raise `merge_rule.max_rounds` in `synthe.json` first)"}. One line per case, for example:\n  \`{"id": "s99", "input": "Can I return shoes I wore once?", "expected": "Explains worn items can't be returned and offers an exchange if they're faulty", "split": "train"}\`\n  \`expected\` describes a good answer in a sentence. \`split\` is \`train\` (Synthe learns from it) or \`holdout\` (kept hidden to check its changes).`);
  }
  if (!state.stopped && !state.proposal && missing(last)) {
    steps.push(`${last!.plain} Once it's fixed, run \`npx synthe restart\`. Until then Synthe spends nothing.`);
  } else if (!state.stopped && !state.proposal && badKey(last)) {
    steps.push(`${last!.plain} Run \`npx synthe restart\` after replacing the key.`);
  } else if (!state.stopped && !state.proposal) {
    steps.push(busy(last)
      ? "Nothing to do. Anthropic's API was busy during the last round, so Synthe tried again; if it has stopped, run `npx synthe restart`. Otherwise Synthe stops by itself."
      : "Nothing to do. Completed rounds start back to back and Synthe stops by itself.");
    steps.push("To keep your agent unchanged, for example before a demo, run `npx synthe stop`.");
  } else if (state.proposal) {
    steps.push("To stop Synthe completely: `npx synthe stop`.");
  }
  if (state.stopped && !state.proposal) steps.push("When you're done with Synthe: run `npx synthe stop`, delete `synthe.json`, `.synthe/` and `.github/workflows/synthe.yml`, and delete the `SYNTHE_ANTHROPIC_KEY` secret in your repo's settings.");
  return steps;
}

// The round on its Actions run page: the outcome, what was tried, the cost and where the full report is.
export function roundSummary(goal: Goal, state: State, record: RoundRecord | null, repo: string): string {
  const { title, summary } = headline(goal, state);
  const report = state.issue ? `Full report: https://github.com/${repo}/issues/${state.issue}` : "";
  if (!record) return [`## Synthe: ${title}`, "", summary, "", report, ""].join("\n");
  const cost = record.costUsd === null ? "unknown" : `$${record.costUsd.toFixed(2)}`;
  const tried = record.tried?.length ? record.tried.map((t) => `- ${t.summary} *${t.outcome}*`) : [];
  return [
    `## Synthe round ${record.round}: ${OUTCOME[record.outcome].toLowerCase()}${record.pr ? ` (#${record.pr})` : ""}`, "",
    ...(record.plain ? [record.plain, ""] : []),
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

export function renderReport(goal: Goal, state: State): string {
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
    `- AI models: writer ${goal.models.writer}, agent ${goal.models.runner}, judge ${goal.models.judge}, rule checker ${goal.models.checker}.`,
    "- How Synthe decides: a change merges only when its replies are better in clearly more test cases than they are worse (more than luck would explain), better again on the hidden test cases, and it breaks none of your rules where your old prompt followed them. The judge's numbers below score each test case 100 when the change's reply is better, 0 when worse and 50 when the same, so 50 is even and 52 is the bar.",
    ...[...state.rounds].reverse().map((r) => `- Round ${r.round}: ${OUTCOME[r.outcome].toLowerCase()}, cost ${r.costUsd === null ? "unknown" : `$${r.costUsd.toFixed(2)}`}${typeof r.writeUsd === "number" ? ` (writing $${r.writeUsd.toFixed(2)})` : ""}. ${r.reasons.join("; ").replaceAll("\n", " ").replace(/candidate-(\d+)/g, "change $1")}`),
    "", "</details>", "",
    ...notTested(goal), "",
    "Only your prompt file can change. Was this useful? React 👍 or 👎 on this issue to tell us.",
  );
  return lines.join("\n");
}
