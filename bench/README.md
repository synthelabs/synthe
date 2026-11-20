# Synthe bench

A free, seeded benchmark of the whole optimizer. Each task has a known truth: some changes are real gains, some
change nothing that matters, and some are traps that only look good. The bench runs the real loop on them and
counts what it kept. No model is called and nothing is spent.

```
npm run bench                          # about 10 seconds: prints the table, writes bench/results.json
npm run bench -- --check               # also fails if false keeps rose or real gains fell against bench/baseline.json
npm run bench -- --check --results F   # checks an existing results file without running
npm run bench -- --update-baseline     # rewrites bench/baseline.json; do this only on main
```

## What runs

**Prompt mode** (`bench/prompt/`) drives the real round, `runWrite` then `runScore` then `runDecide`, the way
`src/action.ts` does: the prompt a merge replaced challenges the current one in the next round, the score step's
caches go to decide, and the run stops on the real stop rules (3 rounds without a winner, `max_rounds`, budget). The
repo is the in-memory fake from `test/helpers.ts`, so a merge really changes the prompt the next round starts from.

Every model call goes to an oracle (`oracle.ts`), told apart by its schema:

- **Writer**: proposes the task's menu of edits in a seeded order, one edit per call, in the writer's own find/replace
  format. It skips edits already in the prompt or already proposed for this exact prompt, and proposes nothing when
  the menu is used up (the round rejects that, as it would a real empty reply).
- **Runner (the agent)**: writes a plain-text reply built from the instructions in the prompt. Each reply has a hidden
  true quality, a quality as the judge sees it (appeal), a length, check and guard marks, and maybe a sentence that
  breaks a guardrail. A small runner noise makes some replies a little better or worse than the prompt deserves.
- **Judge**: in order, picks reply A with chance `position`; picks the longer reply with chance `length`; otherwise
  picks the reply with more appeal, wrong with chance `error`. Each guardrail flag is wrong with chance `guardError`.
- **Checker**: marks the team's checks and guards from the reply's true marks, each wrong with chance `checkerError`,
  and confirms guardrail breaks the same way.

Random draws are hashes of the seed and what is being asked (task, case, the two replies, how often that exact
question came before), never of call order or prompt wording. Rewording a judge prompt doesn't move the numbers;
asking a different question, or deciding differently, does.

**Improve mode** (`bench/improve/`) builds three tiny git repos in a temp folder, measures them with the real
`measureAt`, and runs the real `runLoop` for one round per change on its menu. Jittered metrics read seeded noise
from a counter file outside the repo, so every run sees the same noise in the same order.

## The tasks

| Task | What it measures |
|---|---|
| `clean-judge` | An honest judge (5% error). Are the broad gains found, and the neutral edits and padding left out? `reset-link` helps only account questions (2 of 8 held-back cases), so the held-back sign test can't see it: an expected miss. |
| `length-bias` | A judge that picks the longer reply 45% of the time. Does "be more detailed" (longer, no better) get merged? On today's main it sometimes does. |
| `noisy-position` | A judge with 20% error that picks reply A 30% of the time. Do neutral edits slip through by luck? On today's main nothing merges here, gains included. |
| `gamed-check` | An edit that passes the team's check by pasting the whole policy into every reply, and fails the guard. Do the guards stop it? |
| `guardrail-trap` | An edit the judge likes that promises refunds the policy doesn't allow. Is it blocked? |
| `signup-count` | An exact count. Is the real fix kept and the accept-everything shortcut refused by the regression check? |
| `cart-latency` | A timing with ±1.5 ms noise, lower is better. Is a 1 ms change refused as noise, and a shortcut that returns a constant caught? |
| `ticket-accuracy` | A score with ±1.5 points of noise. Is the real rule kept, and answers looked up from the eval set refused? |

Each task runs with seeds 1, 2 and 3, 6 rounds for prompt tasks and 3 for improve fixtures.

## Reading the table

- **true score start -> end (best)**: prompt mode, the mean true quality of the prompt's replies over every case, with
  no noise, averaged over seeds. Best is the prompt with every real gain on the menu. Improve mode shows the metric's
  median instead.
- **real kept**: merges (or kept rounds) that added a real gain, out of the gains offered.
- **false keeps**: merges that added a neutral edit or a trap (prompt mode), or a noise-level or gaming change
  (improve mode). This is the number that must not rise.
- **missed**: real gains not in the final prompt or code.
- **calls**: model calls by role (w writer, r runner, j judge, c checker); for improve mode, model calls (m) and metric
  runs.
- **cost proxy**: what those calls would cost at the real price list, at about four characters a token. Fake replies are
  short, so this is a floor, not an estimate.
- **per kept gain**: cost proxy (prompt) or metric runs (improve) per real gain kept.
- **held off by re-measuring**: improve changes that won their first measurement and lost the fresh re-measure. Without
  that step they would have been kept.

## Judging a branch

`--check` compares the totals of each mode with `bench/baseline.json`: false keeps may not rise at all, and real gains
may fall by at most one (`TOLERANCE` in `bench/bench.ts`), since a stricter keep rule can fairly trade one borderline
gain. It also prints every task and seed that moved. Results from different seeds or round counts can't be compared and
fail.

To judge a branch that doesn't have the bench yet, bring it in and run the check:

```
git checkout <branch>
git checkout origin/claude/lab-9-bench -- bench scripts/bench.ts
node scripts/bench.ts --check
```

If the branch changed what the round asks a model, the oracle stops with a message naming the call it doesn't know.
Teach `bench/prompt/oracle.ts` to answer it, in the same terms as the existing calls.

As a check that the bench has teeth: loosening the merge rule (`max_p` 0.5, `holdout_max_p` 1, `min_improvement` 0)
raised prompt-mode real gains from 16 to 27 of 33 and false keeps from 3 to 11, and `--check` failed.

## Adding a task

- **Prompt mode**: add a `PromptTask` to `PROMPT_TASKS` in `bench/prompt/tasks.ts`. Reuse or add `MenuItem`s: each is
  one find/replace edit, a marker that shows it is in the prompt, and its truth by kind of message (`quality`,
  `appeal`, `sentence`, `padding`, `checks`, `guards`, `breaks`). A real gain should help most kinds of message, or
  the held-back sign test can't see it.
- **Improve mode**: add a `Fixture` to `FIXTURES` in `bench/improve/fixtures.ts`: the repo's files, a metric command, a
  guard, and three changes on separate lines (real, noise, gaming) so each still applies after another was kept.
- Then run `npm run bench -- --update-baseline` on main and commit `bench/baseline.json` with the new task, so every
  branch is judged against the same numbers.

## Live mode: designed, never run

`npm run bench -- --live` would send the judge and checker calls to a real model while the writer and the agent stay
scripted, to measure how a real judge handles replies whose true quality is known. It:

1. refuses unless `SYNTHE_BENCH_LIVE=1` is set;
2. reads only `SYNTHE_ANTHROPIC_KEY`, never `ANTHROPIC_API_KEY`, and refuses without it;
3. prints the planned judge and checker calls and an upper cost (every reply at its full length limit, as if every task
   ran all its rounds, times 1.5);
4. runs only if that exact cost is typed back;
5. wraps the model so any call that could take spending past that cost is refused before it is sent.

Live results go to `bench/results-live.json` and are never compared with the baseline. It has never been run: ask a
maintainer before spending money on it.
