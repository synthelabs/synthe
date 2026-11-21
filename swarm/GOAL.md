# The goal: Synthe improves anything that can be measured, including itself

## North star

Synthe is a self-improving system for any problem. A person gives Synthe a problem file. The file says which files
Synthe may change, how to measure them, and what must not break. Synthe then proposes changes, measures each one
honestly, keeps only real gains, and learns from every attempt. Synthe runs the same loop on its own code.

The capstone (milestone `FINAL`) is the proof: across the frozen problem zoo in `swarm/zoo/`, `synthe solve` keeps
the real gains and refuses the no-op changes and the traps.

## How done is decided

Each milestone in `swarm/milestones.json` has a check: a test file in `test/milestones/`. A milestone is done when its
check passes on the `integration` branch. Nothing else counts: not a note, not a claim, not a green PR of its own.

```
npm run milestones              # runs every check, prints a pass/fail table
npm run milestones -- P03       # runs one check
```

The checks, the zoo and this file are frozen. The swarm can read them and must not change them:

- `swarm/GOAL.md`, `swarm/milestones.json`, `swarm/zoo/**`
- `test/milestones/**`
- `.github/**`, `.claude/**`, `scripts/swarm/**`, `AGENTS.md`, `CLAUDE.md`

The merge job refuses a pull request that touches a frozen path. If you think a check is wrong, post a note with
kind `check-bug` (see `swarm/README.md`). The coordinator fixes checks. Never work around a check.

## The contract the checks use

The checks call the CLI as a black box: `node src/cli/main.ts <command>`. They import nothing from `src/`, so the code
behind the commands is the swarm's to design. The contract below is fixed.

### The problem file

A JSON file, any name. Paths in it are relative to the folder that holds the file (the problem folder). That folder
must be inside a git repository; Synthe works in scratch checkouts and never edits the person's working tree.

In a scratch checkout, the problem folder is at the same path relative to the repository root. The measure, guard,
proposer, `run` and `compare` commands all run in that problem folder inside the scratch checkout. Every path that
Synthe gives a command or writes in `result.json` (for example `files[].path` and `edits[].path`) is relative to the
problem folder.

```json
{
  "version": 1,
  "name": "short-name",
  "goal": "One plain sentence: what should get better.",
  "artifact": ["src/**/*.py", "config.json"],
  "protect": ["measure/**"],
  "measure": { "command": "python3 measure/score.py", "direction": "higher", "unit": "points", "runs": 3 },
  "guards": ["python3 -m pytest -q"],
  "split": { "holdout": true },
  "proposer": { "command": "node propose.js" },
  "budget": { "max_rounds": 6, "max_calls": 200 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. |
| `name` | yes | Letters, digits and `-`. |
| `goal` | yes | Shown to the proposer. |
| `artifact` | yes | Globs of files Synthe may change. Any file type. A change outside these globs is refused. |
| `protect` | no | Globs Synthe must never change. A change that touches them is refused, even inside `artifact`. |
| `measure.command` | one of two | A shell command, run in the scratch checkout. Its last number on stdout is the score. A leading minus sign belongs to the number: `-20` is -20. |
| `measure.judge` | one of two | A judged measure; see below. |
| `measure.direction` | with `command` | `higher` or `lower`. |
| `measure.runs` | no | Runs per measurement; default 3. |
| `guards` | no | Shell commands that must exit 0 after a change, or the change is refused. |
| `split.holdout` | no | When true, `measure.command` runs with `SYNTHE_SPLIT=train` to compare proposals, and a proposal is kept only if it also wins with `SYNTHE_SPLIT=holdout`. The proposer never sees holdout results. |
| `proposer` | no | `{ "command": "..." }` for an outside proposer, or `"model"` (the default) for the configured model. |
| `candidates` | no | How many proposals Synthe asks for in each round. Default 1. |
| `budget.max_rounds` | no | Default 6. |
| `budget.max_calls` | no | Model calls, when the proposer or judge is a model. |
| `model` | no | `{ "base_url": "...", "model": "..." }` for an OpenAI-compatible chat completions endpoint. Used when `proposer` or `compare` is `"model"`. The key comes only from the `SYNTHE_API_KEY` environment variable, goes only to `base_url`, and never appears in output or files. |

`node src/cli/main.ts problem check <file>` validates a problem file. Exit 0 and a plain summary when it is valid.
Exit 1 and one line per problem, naming the field, when it is not.

### The proposer protocol

An outside proposer is a command. Synthe writes one JSON object to its stdin and reads one JSON object from its
stdout. The command runs in the problem folder inside the scratch checkout.

stdin:

```json
{
  "round": 1,
  "goal": "...",
  "files": [{ "path": "config.json", "text": "..." }],
  "history": [{ "round": 1, "summary": "...", "kept": false, "reason": "..." }],
  "candidates": 1
}
```

`files` holds every file that matches `artifact`, at its current kept version. `history` holds every earlier attempt
for this problem, from this run and from earlier runs. Two runs are the same problem when they have the same `name`
in the same repository. A problem never gets the history of another problem. `candidates` is how many proposals Synthe wants this round.

stdout:

```json
{ "proposals": [{ "summary": "...", "edits": [{ "path": "config.json", "search": "...", "replace": "..." }] }] }
```

`search` must occur exactly once in the file. An empty `proposals` list means "nothing more to try": Synthe stops
with that reason. A reply that is not valid JSON, or an edit whose `search` text does not match, is a failed proposal
with a plain reason in the history. It does not crash the run.

### The judged measure

For problems with no number to print, such as a reply's quality:

```json
"measure": { "judge": { "cases": "cases.jsonl", "run": "node run.js", "compare": "node judge.js" } }
```

- `cases`: one JSON object per line, each with an `"id"` and an `"input"`.
- `run`: gets one case on stdin and prints the output for it, using the files in the scratch checkout.
- `compare`: gets `{ "case": {...}, "a": "...", "b": "..." }` on stdin and prints `{ "winner": "a" | "b" | "tie" }`.
  Synthe asks each question twice with `a` and `b` swapped, and uses a paired test across cases to decide.
  `compare` may also be `"model"`.

### The solve command

`node src/cli/main.ts solve <problem-file> [--out DIR] [--seed N]`

- Runs rounds until the proposer has nothing more, the budget ends, or 3 rounds in a row keep nothing.
- Kept changes go to a new branch, `synthe/solve-<name>-<n>`, in the repository that holds the problem file.
  The person's working tree and current branch do not change.
- Writes `result.json` and `report.md` to `--out` (default: `.synthe/solve/<name>/` in the repository).

`result.json`:

```json
{
  "problem": "short-name",
  "stopped": "plain reason",
  "baseline": 10,
  "final": 12.5,
  "branch": "synthe/solve-short-name-1",
  "attempts": [{ "round": 1, "summary": "...", "kept": true, "reason": "...", "before": 10, "after": 12.5 }]
}
```

`report.md` names each attempt, says whether it was kept, and gives the reason in plain words.

Exit codes: 0 when the run ended normally (with or without gains), 1 for a bad problem file or a failed setup.
