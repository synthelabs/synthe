# Operator mutation testing

Checks how well the tests guard the decision code (`src/core/merge-rule.ts`, `src/improve/verdict.ts`) by making
small mechanical mistakes in it and seeing whether a test fails: comparisons swapped (`<` for `<=`), `&&` for `||`,
`+` for `-`, and conditions forced true or false.

```bash
npm run mutation:operators                       # existing tests + the Lean differential test (needs `cd spec && lake build`)
MUTATION_SET=existing npm run mutation:operators  # existing tests alone
npm run mutation:compare                          # both kill rates, and what only the Lean test catches
```

On a machine where a test fails before any mutation, leave that file out with
`MUTATION_SKIP=test/some.test.ts` (a comma-separated list).

How it stays fast (StrykerJS with its TAP runner):

- **One instrumented copy.** All mutants are compiled in at once, behind switches; nothing is copied per mutant.
- **Only the tests that reach the mutant.** A first full run records which test files execute each mutant; each
  mutant then runs only those, and stops at the first failure.
- **Incremental.** `mutation/reports/incremental-*.json` keeps the last results; a later run re-tests only mutants
  whose code or covering tests changed. CI caches it between runs: every push to `main` runs the job and saves the
  cache, and a pull request restores the newest one from its own branch or from `main`, but only one saved with the
  same hash of everything else in the checkout and the same Node version. Stryker itself only compares the mutated
  files and the test files, so any other change starts from nothing.

The first full run always runs every selected test file, one after another, even with an incremental report. It is
limited to 15 minutes (`dryRunTimeoutMinutes`); on CI it took 3m54s to 4m55s in November 2026, about three times
longer than in early November, when the selection held fewer test files. On a slower machine, raise it for one run with
`npx stryker run mutation/stryker.config.mjs --dryRunTimeoutMinutes 30`.

`npm run mutation` times each mutation against the unmutated run (three times
its duration, at least 60 s and 300 s). Set `MUTATION_TIMEOUT_MS` to use a fixed limit instead.

Measured on an M3 Pro (2026-11-08, 316 mutants): about 3 minutes 50 seconds from scratch (1 minute 12 seconds of
that is the first full test run), 1 minute 20 seconds when nothing changed. The previous approach (a repo copy per
mutant, every importing test file) took about 40 minutes. Every mutant this run reports as surviving was re-run
against all importing test files and survived there too, so the test selection loses no kills.

`npm run mutation` (scripts/mutation-check.mjs) is different: its mutants were written by hand for known failure
modes. These are generated mechanically, so they also find gaps nobody thought to write a mutant for.
