# Examples

Each folder here is a small problem for `synthe solve`. Each one has a problem file, a measure script, a scripted proposer and the files to improve. The proposer (`propose.cjs`) reads its ideas from `ideas.json`. It uses no model, so the examples need no key and cost nothing.

Each proposer offers some real gains and some changes that Synthe must refuse. Run an example to see both.

Run the commands from the root of this repository. Your working tree and current branch do not change. Kept changes go to a new branch, `synthe/solve-<name>-<n>`. The result goes to `.synthe/solve/<name>/result.json` and `report.md`.

| Example | File type | What gets better |
|---|---|---|
| [date-regex](date-regex/) | `.txt` | A regular expression for ISO 8601 dates |
| [cache-config](cache-config/) | `.json` | The settings of a response cache |
| [setup-guide](setup-guide/) | `.md` | A setup guide for new users |

## date-regex

`pattern.txt` holds a regular expression for dates like `2024-01-31`. The measure (`measure/score.cjs`) gives the percent of test cases that the pattern decides correctly. The guard checks that the pattern compiles.

```bash
node src/cli/main.ts solve examples/date-regex/problem.json
```

What you see:

- Kept: "Accept only the months 01 to 12" and "Accept only the days 01 to 31". The score goes from 71.43 to 100.
- Refused: "Accept a year with 2 to 4 digits", because the score goes down.
- Refused: "Remove the failing cases from the test file", because `measure/cases.json` is protected.

## cache-config

`config.json` sets the eviction policy, the capacity and the time to live of a response cache. The measure (`measure/hit-rate.cjs`) replays a fixed request trace and gives the percent of cache hits. The guard (`measure/limits.cjs`) refuses a capacity above the memory limit of 16 entries.

```bash
node src/cli/main.ts solve examples/cache-config/problem.json
```

What you see:

- Kept: "Evict the least recently used entry instead of the oldest" and "Raise the capacity to 12 entries". The hit rate goes from 33.73 to 55.7.
- Refused: "Raise the capacity to 64 entries", because the guard fails.
- Refused: "Lower the time to live to 3 seconds", because the hit rate goes down.

## setup-guide

`SETUP.md` is a setup guide for a small web service. The measure (`measure/lint.cjs`) starts at 100 points. It takes points away for a sentence of more than 25 words, a missing section and an open TODO note. The guard checks that the guide starts with a title.

```bash
node src/cli/main.ts solve examples/setup-guide/problem.json
```

What you see:

- Kept: "Split the long first sentence into three short sentences" and "Add Run and Troubleshoot sections and replace the TODO note". The score goes from 55 to 100.
- Refused: "Remove the Configure section to make the guide shorter", because the score goes down.
- Refused: "Change the measure so that long sentences cost nothing", because `measure/lint.cjs` is protected.
- Refused: "Make the title bold", because the score does not change.

## Run an example again

Synthe saves every attempt in `.git/synthe/solve/<name>/history.jsonl`. The next run sends that history to the proposer. The scripted proposer does not offer an idea again, so a second run stops at once with "The proposer had nothing more to try". To see the full run again, remove that folder:

```bash
rm -rf .git/synthe/solve/date-regex
```

## Make your own

Copy an example folder and change four things:

1. The files to improve, and `artifact` in `problem.json`.
2. The measure script. It must print the score as the last number on stdout.
3. The guard scripts, for things that must not break.
4. `ideas.json`, or replace the proposer with `"proposer": { "agent": "claude" }` to use a coding agent.

Run `node src/cli/main.ts problem check <file>` to check the problem file before you run `solve`.
