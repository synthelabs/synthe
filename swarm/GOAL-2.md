# Stage 2: ready for real models

Stage 1 made Synthe honest on any problem: it keeps real gains and refuses traps. Stage 2 makes it ready to run with
a real model, to measure what that costs, and to help a person write the measure. Every check still runs free, with
loopback fakes. The milestones are `S01` to `S05` in `swarm/milestones.json`. The contract in `swarm/GOAL.md` still
holds. This file adds to it.

After stage 2, the coordinator runs the Synthe score: `solve` with a real model on a hidden problem set that the swarm
never sees. Stage 3 is to raise that score.

## Additions to the problem file

| Field | Meaning |
|---|---|
| `model.provider` | `"anthropic"` or `"openai-compatible"`. Default: `"openai-compatible"` when `model.base_url` is set, else `"anthropic"`. |
| `model.model` | The model id. Required when `proposer` or `compare` is `"model"`. |
| `model.prices` | Optional: `{ "input_per_mtok": 3, "output_per_mtok": 15 }`, in US dollars per million tokens. |
| `budget.max_usd` | Optional. Synthe stops before a model call that would take the known cost above this. It needs `model.prices`; without prices, `problem check` refuses `max_usd`. |

For `"anthropic"`, the key comes from `SYNTHE_ANTHROPIC_KEY`, or from `SYNTHE_API_KEY` when it starts with
`sk-ant-`. The request goes to the Messages API (`POST /v1/messages`). `SYNTHE_ANTHROPIC_BASE_URL` points it at a
loopback fake, as the rest of the repository does. The key goes only there, and never appears in output or files.

## Additions to result.json

```json
"cost": { "calls": 12, "input_tokens": 48000, "output_tokens": 6000, "usd": 0.234 }
```

`calls` counts model calls of every kind (proposer and compare). `usd` is `null` when `model.prices` is not set.
With no model calls, every number is 0 and `usd` is 0.

## The `--resume` option

`solve <file> --resume` continues the most recent run of the same problem when that run stopped before its own stop
rule: a crash, Ctrl-C, or a killed process. It keeps the attempts and kept changes that the stopped run recorded, and
does not repeat a finished round. If the last run ended normally, `--resume` starts a new run and says so.

## The `measure draft` command

The hardest step for a person is to write the measure. This command helps.

`node src/cli/main.ts measure draft --examples <file.jsonl> --out <dir>`

- Each line of the examples file is `{ "input": "...", "good": "...", "bad": "..." }`: an input, a better output and
  a worse output, as a person judges them.
- Synthe asks the model (from `--problem <file>`'s `model`, or `--model <id>` with the Anthropic provider) for a
  judging rubric.
- It writes `<dir>/cases.jsonl` (one case for each example, with `id` and `input`), `<dir>/rubric.md`, and
  `<dir>/compare.js`, a `compare` command for `measure.judge` that asks the model with the rubric.
- It then checks the rubric: for each example it asks `compare.js` about `good` against `bad`, both ways round, and
  prints the agreement with the person's labels as a fraction, for example `agreement 9/10`.
- With agreement below 80%, it says so plainly, names the examples where the judge disagreed, and exits 2. The files
  stay, so the person can fix the rubric.
- `compare.js` is for the person to try the judge by hand. Inside `solve`, problem commands never get the key. So the
  way to use a drafted rubric in `solve` is `"compare": "model"` with `"rubric": "rubric.md"` in `measure.judge`:
  Synthe's own model judge then reads the rubric. `measure draft` prints this snippet.

## Requests to the Anthropic provider

The key goes in the header that the Anthropic SDK in this repository sends, with an `anthropic-version` header. For
`compare: "model"`, the request text gives output `a` before output `b`.

## Synthe on itself

`synthe.self.json` (from P15) works end to end: `solve synthe.self.json` with an outside proposer runs at least one
round on Synthe's own repository, measures with `npm run bench -- --score`, runs the guards, refuses a change that
breaks a test, and leaves the working tree unchanged.
