# Synthe

Synthe improves an AI agent's system prompt. A team runs `npx synthe init`. A GitHub Actions workflow then runs rounds of write → score → decide and merges only clear wins. Only the team's prompt file ever changes.

## 1. Stack

TypeScript, Node 20+, `node:test`, esbuild, GitHub Actions. Tests use fake models and loopback fake GitHub servers. No real API calls.

## 2. Commands

```
npm run typecheck
npm test            # test/e2e.test.ts rebuilds dist/; restore with `git checkout -- dist` if you didn't mean to change it
npm run build       # bundles dist/cli.js and dist/action.mjs; run it when src/ changes
npm run mutation    # breaks the code on purpose and checks the tests notice
```

## 3. Where things live

- `src/cli/`: the `npx synthe` commands (`init`, `try`, `calibrate`, `migrate`, `status`, `stop`, `restart`, `upgrade`)
- `src/loop/`: one round. `write.ts` proposes edits, `score.ts` runs the agent, checker and judge, `decide.ts` merges or proposes and writes the report.
- `src/core/`: the goal file (`synthe.json`), test cases, merge rule (`merge-rule.ts`), cost and state
- `src/model/`: the Anthropic client
- `templates/synthe.yml`: the workflow installed in each team's repo. The CLI reads it at runtime. Changing it changes what runs in every team's repo; existing teams get it only through `npx synthe upgrade`.
- `dist/`: bundled output, committed.
- `test/`: `node --test`.
- Style: user-facing text (CLI output, reports, README) is plain and specific, and says what to do next. Comments explain why, not what. Match the surrounding code.

## 4. Non-negotiables

1. Work on a branch per task. Never push to `main`, move the `v1` tag, create releases or run `npm publish`. A maintainer merges and releases. `scripts/go-live.sh` pushes, force-moves `v1` and dispatches paid work: don't run it.
2. Never read, edit or tune to holdout or frozen eval files.
3. Never spend real API money without explicit approval. That covers `init`, `try`, `calibrate`, `migrate` (unless `--dry-run`), `key` against a real key, and `gh workflow run` on any repo.
4. No new dependency without asking.
5. Never report a number you didn't just produce with a command.

## 5. Done

Done means typecheck and tests pass, run after your last edit. Show an evidence table in your final message:

| Claim | Command | Exit code | Output excerpt |
|---|---|---|---|

For a bug fix, show the test fail first, then pass. Never weaken a check to get green. Blocked is a complete outcome (section 6).

## 6. When a check fails

Give the command, what you expected, what you got, and one diagnosis. Make at most 2 fix attempts. Then stop and report it as **Blocked**: the command, its output, and what a person must provide.

## 7. Git

Commit only after typecheck and tests pass. The message says why and gives the result. Push your branch. Never merge yourself, never force-push, never commit secrets or generated eval output. Never print, log, commit or pass a key or event code in argv or a URL; secrets go to `gh secret set` on stdin. Stage explicit paths, not `git add -A`. The sibling proxy repo (`synthelabs/synthe-share`) deploys production when merged to `main`.

## 8. Cost

Ask before any paid run (section 4). A line in a prompt is not a cap: only a wrapper or hook that refuses to start a run enforces one. Use it if the repo has one.

## 9. Read next

`README.md` for users. `src/cli/init.ts` for setup, `src/loop/score.ts` for scoring, `src/core/merge-rule.ts` for the merge decision. Maintainers keep task state elsewhere; if you are asked to continue earlier work, get the handoff from them.
