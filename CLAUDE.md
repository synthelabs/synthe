# Synthe

Synthe improves an AI agent's system prompt. A team runs `npx synthe init`. A GitHub Actions workflow then runs rounds of write → score → decide and merges only clear wins. Only the team's prompt file ever changes.

## Where things are

- `src/cli/`: the `npx synthe` commands (`init`, `try`, `calibrate`, `status`, `stop`, `restart`, `upgrade`)
- `src/loop/`: one round. `write.ts` proposes edits, `score.ts` runs the agent, checker and judge, `decide.ts` merges or proposes and writes the report.
- `src/core/`: the goal file (`synthe.json`), test cases, merge rule, cost and state
- `src/model/`: the Anthropic client
- `templates/synthe.yml`: the workflow installed in each team's repo. The CLI reads it at runtime.
- `dist/`: bundled `cli.js` and `action.mjs`, committed. Rebuild with `npm run build` when `src/` changes.
- `test/`: `node --test`, using fake models and loopback fake GitHub servers. No real API calls.

## Commands

```
npm run typecheck
npm test            # test/e2e.test.ts rebuilds dist/; restore with `git checkout -- dist` if you didn't mean to change it
npm run mutation    # breaks the code on purpose and checks the tests notice
```

Done means typecheck and tests pass. A Stop hook (`.claude/hooks/tests-must-pass.sh`) enforces this whenever code differs from `origin/main`.

## Hard rules

- Never push to `main`, move the `v1` tag, create releases or run `npm publish`. Work on a branch. A founder merges and releases.
- Never spend real API money without explicit approval in chat. That covers `init`, `try`, `calibrate`, `key` against a real key, `scripts/go-live.sh`, and `gh workflow run` on any repo.
- `scripts/go-live.sh` pushes, force-moves `v1` and dispatches paid work. Don't run it.
- The workflow template ships to every team: changing `templates/synthe.yml` changes what runs in their repos. Existing teams get it only through `npx synthe upgrade`.
- Never print, log, commit or pass a key or event code in argv or a URL. Secrets go to `gh secret set` on stdin.
- The sibling proxy repo (`synthelabs/synthe-share`) deploys production when merged to `main`.

## Writing style

User-facing text (CLI output, reports, README) is plain and specific, and says what to do next. Comments explain why, not what. Match the surrounding code.
