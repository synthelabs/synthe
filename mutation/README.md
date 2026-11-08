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
`MUTATION_SKIP=test/improve-worktree.test.ts` (the src-layout Python test fails on some Macs).

How it stays fast (StrykerJS with its TAP runner):

- **One instrumented copy.** All mutants are compiled in at once, behind switches; nothing is copied per mutant.
- **Only the tests that reach the mutant.** A first full run records which test files execute each mutant; each
  mutant then runs only those, and stops at the first failure.
- **Incremental.** `mutation/reports/incremental-*.json` keeps the last results; a later run re-tests only mutants
  whose code or covering tests changed. CI caches it between runs.

Measured on an M3 Pro (2026-11-08, 316 mutants): about 3 minutes 50 seconds from scratch (1 minute 12 seconds of
that is the first full test run), 1 minute 20 seconds when nothing changed. The previous approach (a repo copy per
mutant, every importing test file) took about 40 minutes. Every mutant this run reports as surviving was re-run
against all importing test files and survived there too, so the test selection loses no kills.

`npm run mutation` (scripts/mutation-check.mjs) is different: its mutants were written by hand for known failure
modes. These are generated mechanically, so they also find gaps nobody thought to write a mutant for.
