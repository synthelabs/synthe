# The rules

These files hold every decision a round makes. Change them only with a test that shows the new behavior, and run
`npm run mutation` afterwards: each rule here has a deliberate break in `scripts/mutation-check.mjs` that a test must
catch.

- `goal.ts`: `synthe.json` and `scenarios.jsonl`, with defaults (writer and checker Sonnet 5.5, runner and judge
  Haiku 5.5; `min_improvement` 2, `max_p` 0.05, `noise_margin` 3, 12 rounds, 3 rounds without a winner, $3).
- `merge-rule.ts`: `judgeRound`. Scores are head to head against the current prompt: 100 a win, 0 a loss, 50 a tie,
  so 50 is even. A candidate merges only if all of these hold:
  1. its training mean is at least 50 + `min_improvement`,
  2. a one-sided sign test on its training wins and losses gives p <= `max_p`,
  3. its held-back mean is at least 50 + `min_improvement`,
  4. it adds no guardrail break where the current prompt kept the guardrail (unknown counts as broken).
  It reverts the last merge when the prompt it replaced now wins by more than `noise_margin` with p <= `max_p`.
- `state.ts`: `State` on the `synthe/state` branch, and `stopReason`: a stop set by a person-needed problem, unknown
  spend, budget, `max_rounds`, or `stall_rounds` rounds in a row without a winner. New scenarios resume only a run
  that stalled.
- `prompt.ts`: finds and replaces the prompt in a file, or as an inline string in code.
- `safety.ts`: which paths may never be changed, secret redaction, and the checks a candidate must pass.
- `cost.ts`: prices per model. A model missing here has an unknown cost, which stops the run.
