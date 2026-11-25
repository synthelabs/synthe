# Changelog

## 1.11.0

### Solve mode: improve any files that a command can score

- Added `npx synthe solve <problem.json>`: Synthe improves files that a command scores (code in any language, JSON configuration, Markdown, CSV). A problem file names the files Synthe may change (`artifact`), the files it must never change (`protect`), the measure, and the guards that must keep passing. Synthe works in a scratch checkout on a new branch, `synthe/solve-<name>-<n>`, and never touches your working tree.
- Added `npx synthe problem init`, which finds your test command and writes a first problem file (for node:test and pytest, with the list of test IDs that count), and `npx synthe problem check`, which validates a problem file field by field.
- Measures: a command whose last printed number is the score, run several times (`measure.runs`) with a keep rule that a change must win twice on fresh runs; an exact measure keeps any change in the right direction. `--seed N` repeats a run.
- Judged measures: when no command can print a number, a judge compares outputs case by case, both orders, with a sign test and length control. `compare` is `"model"` (with an optional rubric) or your own command.
- Added `npx synthe measure draft`, which writes the judge cases, a rubric and a compare program from good and bad examples.
- Guards and protected paths: a change to a file outside `artifact`, to a `protect` file, to a file that the measure, guard or proposer commands use, or to the problem file is refused with the path named. Test files, runner configuration and startup files in a measured folder need an exact `artifact` path.
- Held-back split (`split.holdout`): changes are compared on `SYNTHE_SPLIT=train` and kept only if they also win on `SYNTHE_SPLIT=holdout`. The proposer never sees a held-back number or failed held-back output.
- Several candidates in each round (`candidates`): each is measured and the round keeps at most the best one that passes the keep rule.
- Memory across runs: every attempt is saved in the git folder (`.git/synthe/solve/<name>/history.jsonl`) and sent to the proposer on the next run, so it does not repeat an idea.
- Budgets and cost: `budget.max_rounds`, `budget.max_calls` and `budget.max_usd` (with `model.prices`). `result.json` shows the calls, tokens and dollars of the whole run, also across a resume. Prompt-cache tokens count: a cache write costs 1.25 times and a cache read 0.1 times the input price, and `result.json` shows them in `cache_write_tokens` and `cache_read_tokens`. Parallel model calls cannot pass `budget.max_usd`.
- `solve --resume` continues a run that was stopped or killed. `solve --record` and `--replay` record one real run's model calls and replay them for free. `solve --pr` opens a pull request with the evidence.
- Proposers: your own command (JSON on stdin and stdout), a model (`"model"`: Anthropic, or any OpenAI-compatible endpoint), or a coding agent on your own plan (`{ "agent": "claude" }` or `{ "agent": "codex" }`). The agent runs in a temporary folder that holds only the `artifact` files, with no `SYNTHE_*` variable and a time limit.
- `npx synthe queue` and `npx synthe tick` run solve jobs on a machine that can be replaced at any time; a job that was cut off continues with `--resume`. `docs/RUNNER.md` explains the trigger script, schedules and keys.
- Added three examples that run with no key (`examples/`), a Quick start in the README, and a GitHub workflow template, `templates/synthe-solve.yml`.
- `result.json` and `report.md` give the stop reason, the starting and final scores, the branch, and every attempt with its reason.

### Prompt mode

- Other model providers: any OpenAI-compatible chat completions API (OpenAI, Gemini, Groq, OpenRouter, Together, a local Ollama or vLLM) with your own key in `SYNTHE_API_KEY`, sent only to `provider.base_url`. Free tiers: `npx synthe init` and `npx synthe key` offer Gemini, Groq and OpenRouter, with a call limit in place of a dollar limit and paced requests.
- Added a vault split: test cases that no round ever reads. `npx synthe vault` compares your prompt with the one the run started from on them.
- Added `npx synthe calibrate --judge`: shows you reply pairs and reports how often the judge agrees with you and whether it favours longer replies. The judge prompt now tells the judge not to prefer a reply for being longer, and a merge notes when replies grew much longer.
- Cheaper rounds: a candidate that can no longer pass its training rule stops being scored (futility stopping), and the own-key Anthropic path caches system prompts.
- Changes a person closed without merging, and their reviewer's comment, go to the writer as guidance, so it does not propose them again.
- `npx synthe status` and the report say the smallest gain your test cases can detect, and what to do about it.
- Opt-in options in `synthe.json`: `merge_rule.run_alpha` (a cap on false merges across a run), `merge_rule.allow_shorter` (rounds that shorten the prompt when it is no worse), `population` (a pool of partial winners that are combined) and `compose` (one extra candidate written from how the others behaved).
- Added an agent skill, `skills/synthe/SKILL.md`, for the open skills CLI: `npx skills add synthelabs/synthe` installs it into a coding agent. It tells the agent to run `npx synthe@latest guide` and follow it, so the guide stays the one copy of the setup steps.

### Fixes

- A coding-agent proposer no longer refuses to start when an empty `.git` folder is above the temporary folder; only a real repository counts.
- Solve keeps artifact files editable inside a folder that a measure or guard names, while runner-loaded files there still need an exact path.
- `compare.js` gets only the provider's own key; the judge sees only real outputs; measure, guard, run and compare run with `PYTHONDONTWRITEBYTECODE=1`; a proposal cannot shadow a module or add a package file around a test; `dist/` is written atomically.
- The Codex example in the README now uses `["--skip-git-repo-check", "-s", "workspace-write"]`.

### Removed

- Removed event credit (event and team codes, the capped event proxy, workflow tracking receipts, round events and run records sent to the event server, and the time-limited "full" sharing level); Synthe now uses only your own Anthropic key, and the removed code is kept privately by the Synthe team. Existing own-key setups keep working: run `npx synthe upgrade` to drop the old workflow inputs, and delete `.github/workflows/synthe-diagnostics.yml` if setup added it. A repo set up for the event needs `npx synthe upgrade` (commit and push the workflow) and, if it ran on event credit, `npx synthe key` before its next round.
- The enterprise pilot is no longer part of this package.
