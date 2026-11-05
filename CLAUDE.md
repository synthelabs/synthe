# Synthe

Synthe improves an AI agent's system prompt overnight. A GitHub workflow in the team's repo runs rounds: write two
small edits to the prompt, score them against the current prompt on test cases, and merge only a clear win. It ships
as an npm CLI (`npx synthe init`, `src/cli/`) and a GitHub Action (`action.yml` -> `dist/action.mjs`).

## Where to go

| Task | Read first |
| --- | --- |
| A round: writing, scoring, deciding, the report | `src/loop/CONTEXT.md` |
| The merge rule, state, stop rules, the goal file | `src/core/CONTEXT.md` |
| Setup and the other commands | `src/cli/main.ts`, then `src/cli/init.ts` |
| The workflow teams get | `templates/synthe.yml` (rendered by `init`) |
| Checking that a change works | the `verify-synthe` skill (`.claude/skills/verify-synthe/SKILL.md`) |
| The Crimson Hacks event | `kit/HACKATHON.md` |

## Rules that hold everywhere

- **Code decides, models suggest.** Merges, reverts and stops are decided in `src/core/merge-rule.ts` and
  `src/core/state.ts` from scores. A model never decides whether something ships.
- **Only the prompt changes.** Synthe edits the one prompt file or string named in `synthe.json`, and nothing else in
  a team's repo (`src/core/safety.ts`).
- **The job that writes holds no model key.** `decide` has `contents: write` and no key; `write` and `score` have the
  key and read-only tokens. Keep it that way in `templates/synthe.yml`.
- **Unknown is never a win.** A reply, score or cost that couldn't be measured blocks a merge; it never counts for it.
- **Keep the product simple.** A feature has to earn its place: say what a team gains, what it costs them to
  understand, and what it adds to `state.json` or the workflow. Prefer making an existing thing clearer.
- **Teams read every message.** Report, PR and CLI text is written for someone who has never seen Synthe: plain
  words, what happened, what to do next.

## Commands

- `npm test`: every test (node's runner, `.ts` run directly; needs Node 22.6 or newer).
- `npm run typecheck`: `tsc --noEmit`.
- `npm run build`: rebuilds `dist/`. **`dist/` is committed**: rebuild and commit it with any change to `src/`,
  because teams run the bundle, not the source.
- `npm run mutation`: breaks each rule on purpose and checks a test fails (about 15 minutes).
- `npm run local -- <agent-folder>`: real rounds on this computer against a stand-in for GitHub
  (`scripts/local-round.ts`). Needs `ANTHROPIC_API_KEY`; about $0.10 a round.

## Releases

`init` pins `synthelabs/synthe@v1`, and each release moves the `v1` tag, so a release reaches every team at once.
Only the founders release or publish to npm. Don't move tags or publish from a session.
