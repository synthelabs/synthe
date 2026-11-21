# The Synthe score

The score measures `synthe solve` with a real model on a hidden problem set. This folder is frozen for the swarm.

```
node scripts/score/score.mjs --self-test          # free: the demo set against a loopback fake model
node scripts/score/score.mjs                      # the hidden set; costs money, the coordinator runs it
node scripts/score/score.mjs --problems <dir>     # a plain folder of problems in the layout of demo/
```

## The formula

For each problem, on its held-back split, with the direction taken into account:

- `b`: the score of the baseline. `f`: the score of the branch that `solve` made. `r`: the score of a reference solution.
- Gain share = `(f - b) / (r - b)`, clamped to -1 and 1.
- A false keep is a kept change that is no real gain when the scorer measures it again with more runs. For an exact
  measure, the effect must be above 0. For a noisy measure, the mean effect must be above 0 and a one-sided Welch
  t-test must give p of 0.05 or less. A kept change that breaks a guard is a false keep.

**Synthe score = mean gain share - 2 × (false keeps / kept changes).** With a false-keep rate above 5%, the run is
marked "invalid: too many false keeps". The scorer also prints the cost and the score per dollar.

## What the scorer does

1. It decrypts the set to a temporary folder (`HIDDEN_SET_KEY`), or reads `--problems <dir>`.
2. For each problem it makes a temporary git repository and writes the model into the problem file:
   `model.provider "anthropic"`, `model.model` from `SCORE_MODEL`, `model.prices` from `SCORE_INPUT_PER_MTOK` and
   `SCORE_OUTPUT_PER_MTOK`, and a `budget.max_usd` share of `SCORE_MAX_USD`.
3. It runs `node src/cli/main.ts solve problem.json`. The kept changes are the commits on the branch that `solve` made.
4. It measures the base, each kept commit and the reference on the held-back split. The versions take turns.
   A change outside the artifact globs is put back first, so the real measure is always used.
5. It prints the totals. `--detail <file>` also writes per-problem detail to a file. Never print that file in a log.

## The cost cap

`solve` talks to a loopback gate (`meter.mjs`), not to the API. The gate refuses a call when the money spent, the
calls in flight and the worst case of the new call would pass `SCORE_MAX_USD`. It also holds the real key: `solve`
gets a placeholder. The cost in the score is the sum of `cost.usd` from each `result.json`; the gate's own count is
printed next to it as an upper limit.

## The judge model

A problem file has one model. By default that model is also the judge of a judged problem (`compare: "model"`).
With `SCORE_JUDGE_MODEL`, `SCORE_JUDGE_INPUT_PER_MTOK` and `SCORE_JUDGE_OUTPUT_PER_MTOK`, the scorer gives judged
problems a compare command, `judge.mjs`, that asks the judge model through the gate. `solve` does not make those
calls, so their cost is not in `result.json`: the gate counts it at the judge's prices and the scorer adds it.

## A small run

`SCORE_PROBLEMS=4` (or `--limit 4`) runs 4 problems, spread evenly over the set. Use it for a cheap first run.
Do not compare the score of a small run with the score of a full run.

## Files

- `score.mjs`: the scorer and the self-test. `stats.mjs`: the arithmetic. `meter.mjs`: the gate.
- `judge.mjs`: the compare command for a separate judge model.
- `fake-api.mjs`: the fake model for the self-test. `demo/`: two public toy problems.
- `swarm/hidden/set.tar.gz.enc`: the hidden set.
