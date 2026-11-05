# A round

One round is three jobs in `templates/synthe.yml`, each running `src/action.ts` with a different `step`. They pass
files, never memory: a job only knows what the one before it saved in `.synthe-out/` and what is on GitHub.

| Step | File | Reads | Writes | Holds |
| --- | --- | --- | --- | --- |
| write | `write.ts` | prompt, scenarios, `state.json` (lessons) | `.synthe-out/candidates.json`, output `go` | model key, read-only token |
| score | `score.ts` | `candidates.json`, prompt, scenarios | `.synthe-out/scores.json` | model key, read-only token |
| decide | `decide.ts` | `candidates.json`, `scores.json`, `error.json` | PR, merge, report issue, `state.json` on `synthe/state` | write token, no key |

`go` from write: `true` runs a round, `false` means stopped or too soon, `check` means a proposal waits for review
(decide only looks at the pull request), `recover` means a decide step died partway and must clean up.

## What each step must keep true

- **write** asks the writer for two candidates, each one or two exact find/replace edits (`applyEdits`). An edit
  that doesn't apply, or that adds talk of judging or test cases, rejects the whole candidate. Lessons come only
  from training rows of the current prompt.
- **score** has the runner answer each training case with the current prompt and with each candidate, and the
  judge compare the two replies with the order randomized. When the team set checks, the reply failing fewer checks
  wins and the judge only breaks ties. Only the best candidate that passes training is run on held-back cases. A
  new guardrail break is re-checked and needs a quote that is really in the reply.
- **decide** applies `judgeRound`, then opens `synthe/round-N` and squash-merges it (auto), or leaves it open
  (propose, or branch rules). It saves `state.pending` before touching GitHub, so a crash is recovered next run.
  It records every round, including failed ones, and rewrites the report issue (`report.ts`).

## Failures

`failure.ts` sorts a write or score error into `busy` (retry next hour, not a stall), `key` (a person must replace
it) or `other`. Decide reads `error.json` to choose the report's advice. A run someone cancelled doesn't reach
decide at all.

## Trying a change

`npm run local -- examples/support-bot` runs real rounds through these three steps on this computer; see the
`verify-synthe` skill.
