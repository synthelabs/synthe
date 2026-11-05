---
name: verify-synthe
description: Prove a change to Synthe works before calling it done. Use after any change to src/, templates/ or scripts/, before a commit, a pull request or a release, and whenever someone asks whether Synthe works. Runs the checks in order, stops at the first red, and reports evidence, not impressions.
---

# Verify Synthe

Done means shown, not believed. Work down the ladder, stop at the first red, and report each rung with the command
you ran and what it printed. Never skip a rung and say it passed.

## The five answers

- **Surface**: what a team touches. The CLI (`npx synthe ...`), the workflow (`templates/synthe.yml`), and what it
  leaves in their repo: pull requests, the report issue, `state.json` on `synthe/state`.
- **Run**: `scripts/local-round.ts` runs the workflow's three steps as separate processes, from `src/` (or the
  built bundle with `--bundle`), against a stand-in for GitHub in a folder.
- **Drive**: for rounds, the agent folder and flags of `local-round` (`--rounds`, `--review merge|close`,
  `--fresh`). For setup, the fake `Io` in `test/init.test.ts`. A real `init` changes a real GitHub repo, so a person
  runs that one, in a throwaway repo.
- **Observe**: `<workspace>/view/` (`report.md`, `pr-N.md`, `state.json`, the prompt), each step's log and
  `*.summary.md` in `<workspace>/round-NN/`, and one line per round in `<workspace>/runs.jsonl`.
- **Isolate**: each run gets its own workspace (default `%TEMP%/synthe-local/<agent>`, or `--workspace`). The agent
  folder is copied in and never changed. Nothing reaches GitHub or Actions.

## The ladder

1. **Types**: `npm run typecheck`. Must print nothing.
2. **Tests**: `npm test`. Every test passes. A failure is red even if it looks unrelated: find out why first.
3. **Bundle**: `npm run build`, then `git status -- dist`. If `src/` changed, `dist/` must change with it and be
   committed together; if `src/` didn't change, `dist/` must not.
4. **Free round**: `node --test test/local-round.test.ts`. A whole round through the real steps with a stand-in model:
   proves the plumbing, costs nothing.
5. **Real round** (needs `ANTHROPIC_API_KEY`, about $0.10 a round; ask before spending more than $1):
   `npm run local -- examples/support-bot --fresh --rounds 2`. Then read `view/report.md` and the PR bodies as a team
   would, and say what you saw: the outcome of each round, the cost, check rates, and anything confusing or wrong in
   the text. Use `--bundle` to check what teams will actually run.
6. **Rules** (when `src/core/` or a merge, stop or failure path changed): `npm run mutation`. Every line must say
   `killed`. A `survived` means a rule can break without any test noticing.

## Comparing versions

`runs.jsonl` records Synthe's commit (`+changes` when uncommitted) on every round. To see whether a change made
Synthe better or worse, run the same agent with `--fresh` on the old and the new commit, with the same number of
rounds, and compare outcome, cost and check rates. One run is one sample: models vary, so treat a single difference
as a hint and repeat before you claim it.

## Report

End with a short table: rung, command, result (pass, fail or not run, and why). Say plainly what was not verified,
for example the GitHub side (scheduled wake-ups, branch rules, permissions), which only a real repo shows.
