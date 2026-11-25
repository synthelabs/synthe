import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evidencePath, hashEvidence, type EvidenceRecord } from "../core/evidence.ts";
import { STATE_BRANCH, type Goal } from "../core/goal.ts";
import { findPrompts, readPrompt, writePrompt } from "../core/prompt.ts";
import { sha256 } from "../core/safety.ts";
import type { Repo } from "../github/repo.ts";

export interface UndoDeps {
  repo: Repo;
  goal: Goal;
  root: string;
  slug: string;
  // The prompt file as it stood in each commit that touched it, newest first.
  history: (path: string) => Promise<string[]>;
  say: (line: string) => void;
}

export const undoBranch = (round: number) => `synthe/undo-round-${round}`;

// The prompt text inside one version of the prompt file that hashes to `hash`, or null.
function promptWithHash(source: string, goal: Goal, hash: string): string | null {
  if (goal.prompt.kind === "file") return sha256(source) === hash ? source : null;
  const found = findPrompts([{ path: goal.prompt.path, text: source }]).flatMap((f) => (f.location.kind === "inline" ? [f.location.initial] : []));
  return found.find((t) => sha256(t) === hash) ?? null;
}

// Opens a pull request that puts back the prompt from before one round. Only a hash of that prompt is on record, so
// the text itself comes from git history. Returns the exit code.
export async function undo(d: UndoDeps, roundArg: string | undefined): Promise<number> {
  const { repo, goal, say } = d;
  const round = Number(roundArg);
  if (!Number.isInteger(round) || round < 1) {
    say("Say which round to undo, for example: npx synthe undo 3");
    return 1;
  }
  const local = join(d.root, evidencePath(round));
  const text = existsSync(local) ? readFileSync(local, "utf8") : await repo.readFile(evidencePath(round), STATE_BRANCH);
  if (text === null) {
    say(`No evidence for round ${round}. Rounds that changed nothing or didn't finish have none; check the number against \`npx synthe status\`.`);
    return 1;
  }
  let record: EvidenceRecord;
  try { record = JSON.parse(text); } catch { say(`The evidence for round ${round} isn't readable. Run \`npx synthe verify\` on it.`); return 1; }
  if (hashEvidence(record) !== record.sha256) {
    say(`The evidence for round ${round} doesn't match its hash, so it can't be trusted to undo from. Run \`npx synthe verify\` on it.`);
    return 1;
  }
  if (record.promptHashBefore === record.promptHashAfter) {
    say(`Round ${round} didn't change your prompt, so there's nothing to undo.`);
    return 0;
  }

  const branch = undoBranch(round);
  const existing = await repo.findPr(branch);
  if (existing && (existing.open || existing.merged)) {
    say(`A revert PR already exists: https://github.com/${d.slug}/pull/${existing.number}`);
    return 0;
  }

  const base = await repo.defaultBranch();
  const head = await repo.headSha(base);
  const source = await repo.readFile(goal.prompt.path, head);
  const current = source === null ? null : readPrompt(source, goal, (await repo.readState()).prompt);
  if (source === null || current === null) {
    say(`Couldn't find your prompt in ${goal.prompt.path}, so nothing was changed.`);
    return 1;
  }
  if (sha256(current) === record.promptHashBefore) {
    say(`Your prompt already matches the one from before round ${round}. Nothing to undo.`);
    return 0;
  }
  // Going back to the old text would also drop everything written since, so that is left to a person.
  if (sha256(current) !== record.promptHashAfter) {
    say(`Your prompt has changed since round ${round}, so undoing it would drop the later changes too. Undo the latest change first, or edit the prompt by hand.`);
    return 1;
  }
  let before: string | null = null;
  for (const version of await d.history(goal.prompt.path)) {
    before = promptWithHash(version, goal, record.promptHashBefore);
    if (before !== null) break;
  }
  if (before === null) {
    say(`Couldn't find the prompt from before round ${round} in this repo's git history. Fetch the full history (\`git fetch --unshallow\`) and try again.`);
    return 1;
  }

  const title = `Synthe: undo round ${round}`;
  await repo.commitFile({ branch, baseSha: head, path: goal.prompt.path, content: writePrompt(source, goal.prompt, current, before), message: title });
  const pr = await repo.openPr({
    branch, base, title,
    body: [
      `Puts back the prompt from before Synthe's round ${round}, as asked by \`npx synthe undo ${round}\`.`,
      `Prompt now: \`sha256:${record.promptHashAfter.slice(0, 12)}\`, after this change: \`sha256:${record.promptHashBefore.slice(0, 12)}\`.`,
      "Merge this pull request to keep the undo, or close it to leave the prompt as it is.",
    ].join("\n\n"),
  });
  say(`Opened https://github.com/${d.slug}/pull/${pr} to undo round ${round}. Merge it to put the old prompt back.`);
  return 0;
}
