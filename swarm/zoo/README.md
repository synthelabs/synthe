# The problem zoo

Frozen. Each folder is one problem for `synthe solve`: a `problem.json` under the contract in `swarm/GOAL.md`, the
files it improves, its measure and guard scripts, and a scripted proposer (`propose.cjs` with `menu.json`).

The menu of each proposer mixes real gains, no-op changes and traps. A trap looks good but games the measure, breaks
a guard, edits a protected path or a path outside the artifact, wins on the train split only, or wins only through
the judge's position or length bias. `truth.json` says which item is which. Synthe must never need it: only the
milestone checks (`test/milestones/FINAL-zoo.test.ts`) and the bench read it.

| Problem | Kind of work | Real | No-op | Trap |
|---|---|---|---|---|
| `sort-speed` | code speed (lower is better, noisy) | 2 | 1 | 2 |
| `slug-cases` | count of passing cases (exact) | 3 | 1 | 3 |
| `pool-config` | JSON configuration tuning (noisy) | 2 | 0 | 3 |
| `guide-doc` | Markdown document scored by a script (exact) | 4 | 1 | 3 |
| `contacts-csv` | CSV data cleaning (exact) | 3 | 1 | 3 |
| `phone-regex` | regular expression with a held-back split (exact) | 2 | 1 | 3 |
| `orders-query` | SQL-like query over a JSON table, with a held-back split (exact) | 3 | 1 | 2 |
| `reply-judge` | judged reply quality (measure.judge, biased judge) | 2 | 1 | 3 |
| `py-stats` | Python code, count of passing cases (exact, no package.json) | 3 | 1 | 3 |
| `log-filter` | shell script (exact, no package.json) | 2 | 1 | 2 |
| `bundle-size` | build configuration, size (lower is better, exact) | 3 | 1 | 2 |
| `ticket-router` | routing rules with a held-back split (exact) | 3 | 1 | 2 |
| **Total** | | **32** | **11** | **31** |

## How to run a problem

1. Copy the problem folder into a git repository and commit it.
2. Before the commit, write `noise.json` in the folder: `{ "counter": "/an/absolute/path/outside/the/repo", "seed": "1" }`.
   Noisy measures and the judge read their seeded noise from that counter file. Without `noise.json`, the seed is
   `0` and the counter is in the system temporary folder.
3. Run `node <synthe>/src/cli/main.ts solve <folder>/problem.json --seed 1`.

The proposer proposes one item in each round: the first menu item with no attempt of the same summary in the history,
whose search text still occurs exactly once. So use a fresh repository and a fresh history for each seed.
Commands run in the folder that holds `problem.json`. The scripts use `.cjs` files, so a `"type": "module"`
package.json above the folder does not change them. `py-stats` needs `python3`, and `log-filter` needs `sh` and `grep`.
