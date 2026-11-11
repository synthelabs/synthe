# Enterprise pilot

One support agent, one business metric, reviewed prompt changes, and a **keep / hold / revert** recommendation from an experiment the customer runs. This is a review-first loop: Synthe proposes and measures, and people decide.

Status: built and tested on synthetic data only. It is not wired into `npx synthe` yet (see [What is not wired yet](#what-is-not-wired-yet)). No real customer data, provider or GitHub repo has been used.

## Run the synthetic pilot

From a clean checkout, with no credentials:

```
npm ci
node src/pilot/cli.ts demo --out /tmp/synthe-pilot-demo
```

It takes a few seconds, sends nothing anywhere, and exits 0 only if every expectation holds. The data is invented (Fernhill Outfitters, support agent Juniper). It shows, in order:

1. A baseline report from an imported telemetry export and a frozen metric contract.
2. A proposed change **rejected in replay**: a blocking guard fails, and the report names the case and the turn.
3. A second change that passes replay, gets a review pull request (on a loopback stand-in for GitHub), and is **reverted** when the experiment breaches a critical guard.
4. Approved failures promoted into pack version 2, which then catches the reverted change in replay.
5. A third change, written by a person, that gets **hold** on a day-6 export and **keep** at the cutoff.
6. An interrupted publish that is retried without a second pull request, and a re-imported export that is not counted twice.
7. Refusals: an export dated in the future, an export with an unknown version tag, publishing without the full confirmation or to another repo, an analysis without an approval, a second experiment for the reverted change, and a later export for an experiment that was already reverted.
8. Privacy checks: strings planted in the pack do not appear in anything printed, reported or sent.
9. Verification: every record matches its id, every decision recomputes to the same result, and the journal still holds the head that was noted after the revert.

Open these afterwards:

| File under `<out>/pilot/` | What it is |
|---|---|
| `reports/PILOT.md` | The whole pilot on one page. Every line cites the record it comes from. |
| `reports/review-<candidate>/REVIEW.md` | The review bundle, which is also the pull request body. |
| `reports/decision-<experiment>.md` | The latest decision for an experiment. Earlier ones keep their own file. |
| `reports/replay-<candidate>-pack-v<n>.md` | Paired replay results, coverage, regressions by turn, the gate. |
| `journal.jsonl` | Every step, in order, each line chained to the one before. |
| `objects/<kind>/<id>.json` | The records. Each is named by the SHA-256 of its content. |

The inputs the demo generated are in `<out>/inputs/`. Read them as examples of each format below.

## The operator flow

All commands are `node src/pilot/cli.ts <command> --dir <pilot directory>`. The directory holds customer data (packs, telemetry rows). Keep it in the operator's environment. `init` writes a `.gitignore` inside it so it cannot be committed by accident.

| Step | Command | What it does |
|---|---|---|
| 1 | `init --config pilot.json --repo-dir <checkout> [--rev <commit>]` | Freezes the contract and reads the baseline prompt at an exact commit. A frozen contract is never edited: a new contract needs a new directory. |
| 1 | `baseline --telemetry <export.json>` | Imports the customer's baseline export and writes `reports/baseline.md`: the team's own number, its interval, and how many conversations each arm needs. |
| 2 | `pack --file <pack.json>` | Validates and freezes the redacted conversation pack. |
| 2 | `discover --model …` | Replays the baseline prompt and lists checks that fail in several discovery cases. |
| 2 | `propose --finding <id> --proposer …` or `--file <prompt> --author <name> --rationale <why>` | One narrow candidate, from a proposer or a person. |
| 2 | `replay --candidate <id> --model …` | Both prompts on the same cases. Writes the replay report and the gate verdict. |
| 3 | `experiment --candidate <id> --start <UTC time>` | Writes the specification the customer runs. Refused unless the replay gate passed. |
| 3 | `review --candidate <id>` | Writes the local review bundle. Nothing is published. |
| 3 | `review … --publish --repo <owner/name> --base <branch> --confirm <full candidate id>` | Opens the pull request. See [Publishing](#publishing). |
| 3 | `approve --candidate <full id> --experiment <full id> --approver <name>` | Records a person's approval of exactly that candidate and experiment. `--reject` records a rejection. |
| 4 | `analyze --experiment <id> --telemetry <export.json>` | Imports the outcome export and prints keep, hold or revert. Without `--telemetry` it recomputes from what is stored. |
| 5 | `promote --list`, then `promote --request <request.json>` | Approved failures become regression cases in a new pack version. |
| any | `status`, `report`, `verify [--head <hash>]` | Where things stand; rebuild `reports/PILOT.md`; recheck every record and recompute every decision. |

`--model` is `scripted:<file>` (a local rule file; sends nothing) or `--live` (see [Live model provider](#live-model-provider)). There is no default: a command that needs a model and is not told which one refuses.

Every command can be run again. A repeated step finds its earlier record and adds nothing.

## pilot.json

```json
{
  "version": 1,
  "pilot_id": "fernhill-juniper",
  "agent": { "name": "Juniper", "prompt_path": "prompts/juniper.md", "baseline_tag": "juniper-v14" },
  "repo": { "slug": "fernhill/support-agent", "base": "main" },
  "metric": {
    "version": 1,
    "primary": { "name": "resolved", "kind": "rate", "unit": "share of completed conversations resolved without a person", "direction": "higher_is_better", "min_effect": 0.03 },
    "guards": [
      { "name": "escalated", "kind": "rate", "unit": "share of completed conversations handed to a person", "direction": "lower_is_better", "max_harm": 0.02, "critical": true, "early_stop": { "min_per_arm": 400 } },
      { "name": "refund_usd", "kind": "mean", "unit": "USD refunded per completed conversation", "direction": "lower_is_better", "max_harm": 0.75, "critical": false }
    ],
    "denominator": "completed_conversations",
    "randomization_unit": "conversation",
    "alpha": 0.05, "power": 0.8, "min_samples_per_arm": 1000,
    "analysis_window_days": 14, "outcome_lag_days": 2,
    "max_missing_rate": 0.02, "max_unattributed_rate": 0.02,
    "signed_off": { "by": "Tomas Lindqvist (head of support, Fernhill)", "at": "2026-09-29T15:00:00Z" }
  },
  "replay": {
    "model": "juniper-sim", "max_tokens": 800, "temperature": null, "max_steps_per_turn": 4,
    "gate": { "min_paired_cases": 10, "min_paired_coverage": 0.7, "min_net_wins": 3, "max_unchecked_blocking_guards": 0 },
    "min_recurring_cases": 3, "max_changed_lines": 6
  },
  "provider": null
}
```

- `kind` is `rate` (each conversation is 0 or 1) or `mean` (a number per conversation).
- `min_effect` and `max_harm` are absolute, in the metric's own units. For a rate, 0.03 is three percentage points.
- `outcome_lag_days` is how long an outcome takes to become final. Younger conversations are left out until they mature. A lag longer than the window is refused: that outcome cannot be attributed in the pilot.
- `baseline_tag` is the tag the customer's telemetry already carries for the current prompt.
- `provider: null` means only scripted models run.
- Unknown fields are refused, so a typo cannot silently become a default.
- Optional: `metric.query_hash` pins the customer's metric query. An export with another hash is refused as denominator drift.

## Telemetry export

The customer produces the export. Synthe only reads the file. One JSON file, with the rows inline, in a CSV next to it, or as aggregates:

```json
{
  "format": "synthe-pilot-telemetry/v1",
  "export_id": "fernhill-exp2-final",
  "source": "Fernhill analytics warehouse, saved query support_outcomes_by_prompt_version",
  "exported_at": "2026-11-12T00:00:00Z",
  "window": { "start": "2026-10-27T00:00:00Z", "end": "2026-11-10T00:00:00Z" },
  "assignment": "randomized",
  "denominator": "completed_conversations",
  "units": { "resolved": "share of completed conversations resolved without a person", "escalated": "…", "refund_usd": "…" },
  "expected_rows": 8960,
  "rows_csv": "experiment-2-final.csv"
}
```

Fields the customer must map from their telemetry source:

| Field | Meaning |
|---|---|
| `conversation_id` | One row per conversation in the denominator. An opaque id, not an email or phone number. |
| `prompt_version` | The tag of the prompt that served the conversation: the baseline tag, or the candidate tag the experiment specification names. Any other tag refuses the whole export. |
| `started_at` | UTC time the conversation started. Must be inside `window`. |
| one column per metric | The contract's metric names. `0`/`1` for a rate, a number for a mean, empty when the outcome is not known yet. |
| `segment` (optional) | A cohort label such as channel. Used to check the arms are balanced. |
| `unit_id` (optional, recommended) | The customer's assignment key, already hashed. A unit seen in both arms is ambiguous attribution and is left out. It also lets the import recognise one conversation exported under two ids. |
| `model_id` (optional) | The runtime model. More than one value holds the result. |

Header rules: `units` and `denominator` must match the contract word for word. `assignment` is `none` for a baseline, `randomized` for an experiment, or `observational` (accepted, but it can never give keep). `expected_rows` is the number of conversations the source holds for the window, so a truncated export is caught. Extra columns are refused: export only these fields.

Aggregates form, when rows cannot leave the warehouse: replace `rows_csv` with

```json
"aggregates": [
  { "prompt_version": "juniper-v14", "n": 4480, "immature": 0, "unattributed": 0,
    "metrics": { "resolved": { "kind": "rate", "successes": 2772, "missing": 0 }, "refund_usd": { "kind": "mean", "mean": 4.2, "sd": 10.0, "missing": 0 } } }
]
```

`n` counts mature, attributable conversations. Each aggregate export must be cumulative from the experiment start; only the newest is used. With aggregates Synthe cannot check duplicates, unit overlap or a runtime change, so it takes the customer's counts as given.

Rules that keep the counts honest:

- The same export twice counts once.
- A value on a conversation that was still inside the outcome lag when exported is provisional. It is stored as not known yet, and counts only once an export made after the lag carries it.
- A later export must contain every conversation an earlier export had for the time both cover. It may add conversations and fill in outcomes. Conversations that vanish are refused.
- One conversation under two ids is refused when the rows carry `unit_id`: the same unit, start time, version and values twice.
- Without `unit_id`, two conversations can share a start time and every value by chance, so one twin proves nothing. The export is refused when far more rows have an exact twin than chance explains for rows that share a start time (more than 5% of the rows above the expected number, and more than seven standard deviations). The expected number allows for values that follow the clock, such as a channel that is busy only by day: it is worked out from the rows nearest in time as well as from the whole export. That many exact twins is what an export with conversations in it twice looks like. If they are separate conversations, add `unit_id`.
- Conversations that are only in a later export, although they were older than the outcome lag when an earlier export of the same period was made, are counted (`late rows` in the decision). They finished later than the outcome lag, or reached the source late. The final export holds them, so they do not hold the result. More than 5 of them, and more than 2% of the other rows, add the note `late_rows`: the earlier exports were incomplete, and the contract's outcome lag may be too short.
- A changed value, tag or time for a conversation already imported is refused. So is a newer aggregate export that counts less than an older one; a count may fall only by as much as that arm's `unattributed` count rose.
- Every export of a pilot must carry the same `query_hash` (or none), the baseline's included.
- An export dated later than the moment it is imported is refused.
- A refused export leaves no record, so the next correct export still imports.
- A keep or a revert ends the experiment. It takes no more exports after that, and its candidate gets no second experiment: a stopped change cannot come back as a keep.

## Conversation pack

A bounded, redacted export the customer approved for replay. One case:

```json
{
  "id": "ret-d01", "split": "discovery", "intent": "return",
  "provenance": { "kind": "export", "ref": "fernhill-export-2026-09/ret-d01", "added_in_pack_version": 1 },
  "messages": [
    { "role": "user", "text": "Hi, I would like to return the ridge boots from order ORD-0744." },
    { "role": "assistant", "text": "", "tool_calls": [{ "id": "ret-d01-a", "name": "lookup_order", "input": { "order_id": "ORD-0744" } }] },
    { "role": "tool", "tool_call_id": "ret-d01-a", "name": "lookup_order", "result": "Order ORD-0744: Ridge Boots, delivered 2026-09-11, total 99.00 USD." },
    { "role": "assistant", "text": "Good news: this order can be returned. Do you want me to start the return?" }
  ],
  "checks": [
    { "id": "states-return-deadline", "turn": 1, "role": "primary", "kind": "reply_includes", "any_of": ["return by"] },
    { "id": "eligibility-before-return", "turn": 1, "role": "guard", "blocking": true, "kind": "tool_requires", "tool": "start_return", "after": "check_return_eligibility" }
  ],
  "observed": { "resolved": true, "repeat_contact": true }
}
```

- `split` is `discovery` (a proposer may see the case) or `heldout` (it never does, in this pack version or any later one).
- Checks are yes/no facts about one assistant turn, decided by code: `reply_includes`, `reply_excludes`, `calls_tool`, `avoids_tool`, `tool_requires`. `primary` checks make the case score. `guard` checks only catch harm; a `blocking` guard that a candidate newly fails keeps it out of review.
- `check_catalog` at the top of the pack gives each check id one plain sentence. Reports print that sentence, never conversation text.
- `observed` is what happened to the real conversation under the old prompt. It is reported in its own section and never mixed into replay results.
- The pack header names who exported it, who approved the redaction, and `approved_uses`, which must include `"replay"`.

Import refuses a pack that is not approved for replay, has unknown fields, exceeds the size limits (2,000 cases, 200 messages per case, 20,000 characters per message), or contains what looks like an email address, a payment card number, a national identity number or a credential. Tokenise those (`[EMAIL_1]`) and keep tokens that decide correctness, such as order tokens.

## What replay does, and what it cannot say

- Each assistant turn is replayed against the **recorded** history up to that turn, with the same settings for both prompts.
- A tool call gets the recorded result for the same tool and arguments. No tool is ever run. A call the recording has no result for makes the turn `unsupported`: nothing is invented, and the case stops counting in the comparison there. Its later turns are still replayed for their guard checks (below).
- A cut-off, refused or failed reply makes the turn `inconclusive`.
- When a reply behaves differently from the recorded one (other tool calls, or a different result on that turn's checks), the case stops counting in the comparison from the next turn: the recorded customer was answering the old agent. A change that fixes a failure diverges by design, so expect it.
- Those later turns are still replayed against the recorded history (`after_stop`), for their guard checks only. Harm seen there blocks the candidate like any other. A blocking guard that could not be decided for the candidate (its turn did not finish) counts against it: a guard nobody checked is not a pass.
- A case is **paired** when at least one turn was scored for both prompts. The report gives wins, losses and ties, coverage (paired cases, turns scored on both), excluded cases with the reason and turn, each regression with its case, turn and check, and new blocking guard failures.
- The gate passes only when: no new blocking guard failure; no more unchecked blocking guards than the config allows; enough paired cases and coverage; wins minus losses reaches the minimum; at least one held-out case was compared and held-out cases do not lose; and the targeted check is fixed somewhere.
- What replay does not see: a reply that passes the same checks with the same tool calls but says something different does not count as a divergence, and later turns never contain the candidate's own earlier replies.
- The proposer gets discovery cases only. Its feedback after a rejection names discovery cases only; a problem on held-out cases is reported to it as one fixed sentence.

Replay shows checks on recorded conversations. It is not an estimate of business impact. That is what the experiment is for.

## The experiment and the decision

`experiment` writes a specification the customer's rollout owner runs with their own controls: the two tags, the intended split, the window, the cutoff (window end plus outcome lag), the conversations needed per arm, the stop rules and the fields to export. Synthe never changes traffic. Only one approved experiment may be open at a time, for the same candidate too: `experiment` and `approve` both refuse a second one, because two experiments on one candidate would read the same tagged conversations. A specification can be written again (a new start date) until it is approved; only the newest one can be approved. To close an approved experiment that will not run, record `approve --reject` for it.

The analysis is fixed in the specification before any outcome is seen:

- **Keep**: only at the final analysis (an export made at or after the cutoff), with clean data, when the primary metric's gain is at least `min_effect` and its interval is above zero, and every guard's interval for harm is inside its `max_harm`.
- **Revert**: at the final analysis when a guard breaches (the whole interval for its harm is above `max_harm`) or the primary is significantly worse. Before the cutoff, only a critical guard's early stop reverts: the same test at 99.9%, once both arms have the guard's `min_per_arm`.
- **Hold**: everything else. Before the cutoff; too few mature conversations; outcomes still inside the lag; a sample ratio mismatch; a cohort imbalance, or segments reported for one arm only; missing events above the limit, or far more common in one arm than the other; ambiguous attribution above the limit; observational data; more than one runtime model; no single export that covers the whole window; a primary that does not clear; a guard that is not shown to be safe.

A guard has three outcomes. Pass: the whole interval for harm is inside `max_harm`. Breach: the whole interval is beyond it. Otherwise it is inconclusive, which holds. Harm that is real but may still be inside the margin is not a breach, because the contract says the team tolerates that much; it is not a pass either.

Methods: a rate uses the Newcombe hybrid score interval for the difference of two proportions; a mean uses the Welch interval. Sample ratio and cohort balance use chi-square tests at 0.001. The required sample size is the standard two-sample formula at the contract's alpha and power.

Known limits of the method. Read these before you rely on a decision:

- Conversations are treated as independent. If one customer has many conversations, intervals are too narrow.
- The experiment is sized to detect `min_effect`. A change whose true effect is exactly `min_effect` is kept only about half the time, because keep also needs the measured gain to reach `min_effect`.
- Each guard is tested on its own. With several guards, a false revert is more likely than alpha suggests.
- The early stop is a fixed 99.9% check at every look, not a formal sequential boundary. Many looks raise the chance of a false stop.
- `final` depends on the export's own `exported_at`. The export is the customer's statement; Synthe cannot audit how the split was run. An export dated in the future is refused, but an honest-looking date cannot be checked.
- Rows left out of one arm are caught only when the split moves far from the plan (p below 0.001) or the later export no longer contains conversations an earlier one had. A few percent of one arm's failures dropped from the very first export can pass unnoticed.
- Missing outcomes are checked two ways: the share in each arm against the limit, and one arm against the other. Outcomes that are missing equally often in both arms, but for the baseline's successes and the candidate's failures, pass both checks and make the candidate look better. Keep `max_missing_rate` low, and ask the customer why outcomes are missing.
- A second copy of a conversation is recognised only when it is exact (same start time, version, segment and values). A copy with a changed start time or value, or copies in an export with one timestamp per day, cannot be told from more conversations. Send `unit_id`.
- The outcome lag is the customer's statement of when an outcome is final. If many conversations finish later than it, the last days of the window are missing their slow conversations at the cutoff. The `late rows` count shows this only when there was an earlier export to compare with.
- A guard that is harmful but not yet shown to be beyond its margin holds; it does not revert. With little data that can take the whole window.
- A mean metric with heavy tails (refunds, revenue) needs more data than the formula says.

Each decision file leads with the recommendation and the team's own number, lists every number with its source record and method, and gives the exact rollback target (the baseline tag and prompt id).

## Publishing

The default is a local bundle. A pull request is opened only when all of these hold:

- `--publish`, `--repo` and `--base` equal to `pilot.json`, and `--confirm` equal to the full 64-character candidate id.
- A GitHub token in `SYNTHE_PILOT_GITHUB_TOKEN`. `GITHUB_TOKEN` and `GH_TOKEN` are not read.
- The candidate passed the replay gate.
- The prompt on the base branch is still the baseline prompt the candidate was built from.
- The title, body, commit message and candidate prompt pass the egress check (below).

The egress check looks for content that belongs to particular conversations. It flags:

- a run of three words that appears in only a few cases of the pack (two, or 2% of the cases if that is more). Wording that many conversations share is the agent's and the tools' own boilerplate;
- a single word of five letters or more that appears in only a few cases;
- a word the conversations write with a capital inside a sentence and never in lowercase (a name, a place), and a word of three characters or more that has a digit (an order token, a postcode). These are flagged however many cases they are in, because a returning customer is in many.

Matching ignores case, spacing, punctuation, accents, dash variants and hidden characters, and reads Cyrillic and Greek letters that look like Latin ones as the Latin ones. A word that mixes alphabets is refused on its own. Personal data shapes (an email address, a card number) are refused whatever the pack holds.

Allowed: the baseline prompt and the review's own generated wording. Case ids, check ids, catalog sentences and tool names pass as whole identifiers only, because the reports print them by design; a word inside a case id is not allowed anywhere else. So the free text that is really checked is the rationale and the changed prompt lines. A refusal names the part, the kind of match and the line, and never repeats the match; reword the candidate or the rationale and run `review` again. The local bundle is checked the same way.

Markup cannot hide a name. The rationale and the diff are printed in the review as literal text (a code block), so a character reference or a tag in them is shown as typed, not rendered. The check also reads the text the way a page would show it (character references decoded, tags and link targets removed, percent escapes read), and looks for a name across adjacent words, so `Th&#97;ddeus`, `Thad<b></b>deus`, `Thad-deus` and `T h a d d e u s` are found.

The check is strict on purpose, so it also stops some harmless text: a status the tools always write with a capital (`Delivered`), a weekday, a product name. Word the change without such a word. (A word that is in the baseline prompt is allowed, but the baseline prompt is frozen for the pilot.) Bracketed all-capital tokens such as `[EMAIL_1]` are read as redaction placeholders, not names.

Limits of the check. It is a net under the reviewer, not a proof:

- It cannot see a paraphrase, or text in a code (base64, a cipher).
- A name the conversations also write in lowercase, or a name that is an ordinary word in the baseline prompt (Will, Rose), is not flagged on its own. A short lowercase name is caught only inside a three-word run.
- A name that only ever starts a sentence in the conversations is treated as an ordinary word unless it is rare.
- Only names are looked for across adjacent words. An order token whose digits are split with spaces or hyphens, or a rare lowercase word that is split, is not found.
- Wording that three or more conversations share is treated as boilerplate, in a small pack too.
- Look-alike letters are folded for Cyrillic, Greek and Latin small capitals only.
- The committed prompt file is checked the same way, but how a viewer renders that file is outside the check.
- Case ids, check ids, catalog sentences and tool names are printed in reports and pull requests as they are. The customer must write them without customer details.

Read `REVIEW.md` before you publish it.

Only one publication of a candidate runs at a time, in one process or several. A retry, or a second run, finds the existing pull request for the candidate's branch and opens nothing. Merging is a person's decision. The pull request body is the review bundle: the diff, the contract, replay evidence, the experiment plan, the rollback target, every id, and the approve command.

## Live model provider

Not used in the demo or the tests, and not exercised against a real API. It is tested against a stand-in transport only.

A live model runs only when `pilot.json` records the approval and the operator opts in for that one command:

```json
"provider": { "provider": "anthropic", "endpoint": "https://api.anthropic.com", "model": "claude-opus-5-5", "key_env": "FERNHILL_PILOT_KEY",
  "data_class": "redacted support conversations (pack)", "approved_by": "Rhea Castellan (data protection, Fernhill)", "approved_at": "2026-10-01T00:00:00Z",
  "max_calls": 500, "max_input_chars": 2000000 }
```

```
node src/pilot/cli.ts replay --candidate <id> --live --confirm-endpoint https://api.anthropic.com --confirm-data "redacted support conversations (pack)"
```

- The key is read from the one variable `key_env` names. There is no fallback to `ANTHROPIC_API_KEY`, `SYNTHE_ANTHROPIC_KEY` or an event code, and Synthe's event proxy is never used.
- The destination, model, data class and limits are printed before the first request. The call that would pass a limit is refused before it is sent. One counted call is one request: the SDK's own retries are off, and a call that gets no answer in two minutes is given up, not sent again.
- Settings in the shell cannot change the request: the base URL, a second credential, extra headers, request logging and tracing are all fixed or off.
- `replay.model` must equal the approved model. Both prompts must run on the same model.
- Model output is data. A tool call is only used to look up a recorded result.

A live run sends pack conversations to the provider. That needs the customer's written agreement first.

## Records and verification

- Records are write-once and named by the hash of their content. A record that no longer matches its name is refused.
- The journal is append-only and chained. An edited journal, or one with lines missing from the middle, is refused.
- The newest journal entry's number and hash are kept in `journal.head`, so entries cut off the end are noticed. `verify` and `analyze` print that head.
- `verify` rechecks every record and the journal, then recomputes every replay report, baseline report and decision from its stored evidence and compares. It also checks that:
  - each import's summary follows from its own rows;
  - each decision cites only exports imported for its experiment before the decision, and an approval that answers one of this pilot's review bundles;
  - each replay report was built from the recorded runs;
  - nothing was imported or decided for an experiment after its keep or revert, and no second experiment was written for a decided candidate.
- Records that no journal entry names are listed by kind. An interrupted step leaves such records; so does a journal that was cut back.
- Reports under `reports/` are renderings. They can be deleted and rebuilt with `report` and by re-running the step.
- Nothing is sent to Synthe: no events, run records or shared results.

What `verify` cannot show. Someone who can write to the pilot directory can still:

- import a made-up export for an experiment that has no decision yet. `verify` shows that a decision follows from its exports, not that an export is truthful;
- cut entries off the end of the journal and rewrite `journal.head` to match. The directory then agrees with itself.

To catch the second, note the journal head outside the directory when it matters (after a review, after each decision), for example in the pull request. `verify --head <hash>` passes only if the journal still holds that entry.

An unexpected error prints only its kind, because an error message can quote the data it choked on. Run the command again with `SYNTHE_PILOT_DEBUG=1` to see the text.

## Promotion

`promote --list` prints the failures a reviewer may approve: every check that failed in a stored replay on the active pack. The request names the approver, existing cases with the replay evidence, and any new redacted cases (for example from the experiment) with the experiment id.

The result is a new pack version that names the old one as its parent. The old pack is not changed. A held-out case stays held out. `promote` is the only way to make a new version: the `pack` command refuses any pack once one is frozen, and a promotion that would put a held-out conversation in the discovery split, under its own id or as a copy, is refused. A copy is recognised by what the customer said, whatever its case, spacing or punctuation and whatever the agent's side says, when the customer said eight words or more. A shorter conversation is a copy only when every message is the same, because many customers write the same few words. The same rule applies when the first pack is frozen. A case that a promotion adds is held to a stricter rule: it is refused as a discovery case when four in five of the three-word runs of the customer's text (of the shorter of the two texts, and at least six runs) are a held-out conversation's. So a copy with a word added, or a sentence dropped, is refused; a different conversation that reads much like a held-out one must be added as held out. A copy rewritten beyond that cannot be recognised, and a held-out case is only known inside its own pilot directory: the approver must not add one from elsewhere.

## Checks

```
npm run typecheck
node --test test/pilot-*.test.ts
node scripts/pilot-build.mjs                 # one-file bundle in .synthe-local/pilot/, same bytes every build
node scripts/pilot-mutation-check.mjs        # in its own worktree, never two at once
```

## What is not wired yet

Left out on purpose, because other work in flight owns these files:

1. **`npx synthe pilot`.** In `src/cli/main.ts`, add a `pilot` command that calls `main(process.argv.slice(3), defaultDeps())` from `src/pilot/main.ts` (that module has no side effects on import), and a line in `HELP`. Then `npm run build` and commit `dist/cli.js`.
2. **`package.json`.** Optional scripts: `"pilot": "node src/pilot/cli.ts"` and `"mutation:pilot": "node scripts/pilot-mutation-check.mjs"`.
3. **`README.md`.** One line pointing here.

Until then, run from a checkout with Node 22.18 or later (the runtime the repo's tests use), or build the bundle.

## What a real pilot still needs

- The customer's sign-off on the metric contract: metric, units, denominator, minimum effect, guards, window, lag.
- Data terms: who redacts the conversation export, retention and deletion, and whether redacted conversations may be sent to a model provider (and to which endpoint).
- Repository scope: the repo, the prompt file, the base branch, and a token that can open pull requests there.
- A telemetry mapping: which query produces the export fields above, and whether telemetry can already be split by prompt version.
- A rollout owner at the customer who runs the split, tags traffic and exports outcomes.
- Daily volume and outcome delay, to know whether the experiment can be powered inside the window.
- A judged check kind, if the team's checks cannot be written as the five coded kinds. It is not built.
