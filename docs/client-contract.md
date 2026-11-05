# The client contract

What the Synthe client (the `synthe` npm package and the workflows it installs in a team's repo) promises the Synthe services, and what it expects back. The services live in `synthelabs/synthe-share`. When a behaviour here changes, both repos change in the same release, and this file is updated in the same pull request.

Two services:

- **Round events:** `POST https://synthe-share.vercel.app/api/round`
- **Sponsored model credit:** `POST https://synthe-share.vercel.app/api/claude/v1/messages`

Each section ends with its build status, so nobody mistakes a plan for a shipped behaviour.

## 1. The team code

At an event, each team gets one team code (on their QR card at Crimson Hacks). The code is how the sponsored credit knows which team is calling.

- **Asked once.** `npx synthe init` asks for the code during setup, with typed input hidden, the same way it asks for a key. A team with its own Anthropic key can skip it and never uses the proxy.
- **Stored privately.** Init saves the code as the GitHub repo secret `SYNTHE_EVENT_CODE`, so workflow runs can use it. Local runs read the `SYNTHE_EVENT_CODE` environment variable. The code never goes in `synthe.json` or any other committed file, never in a round event, and is never printed in output or logs.
- **Sent on every model call.** Every call made on event credit goes to the proxy with the header `x-synthe-event: <code>` and a placeholder API key (the proxy ignores `x-api-key`). Calls from the GitHub Action also send `Authorization: Bearer <OIDC token>` with audience `synthe-proxy`, and the service checks the token names this repo and its `.github/workflows/synthe.yml`. Local calls (init, `try`, `calibrate`) instead send `x-synthe-install: <UUID>`, one per install, so setup spend can be capped per install.
- **Limits the client respects.** Event credit covers only `claude-haiku-5-5` and `claude-sonnet-5-5`, at most 16000 output tokens per call. The client refuses any other model up front with a plain message naming the fix (use an allowed model, or `npx synthe key` to switch to the team's own key). All dollar caps live on the server; the client never guesses, shows, or works around them.
- **Refusals.** A 402 or 403 with error type `synthe_credit` means the credit is used up or the event window has closed: the client shows the server's message word for word and does not retry. A 401 with type `synthe_proxy_auth` means the workflow's identity token was not accepted: the client prints the fix (run `npx synthe upgrade`, then `npx synthe restart`). A 503 shows the server's message. Nothing about a refusal is silent.

*Status: built on both sides, awaiting coordinated merge: client in synthe PR #14, service in synthe-share PR #2. Neither merges alone.*

## 2. Round events

So the team can see a round while it happens, and so a stuck round is visible to us, the round workflow sends events to `POST /api/round`.

- **Identity.** Every event carries a GitHub OIDC token with audience `synthe-share`. The service verifies the token names this repo and its `.github/workflows/synthe.yml`. The client never sends another repo's identity, and there is no shared secret for events.
- **Stages.** One event per stage, each with the repo, the round number, the stage name, and the client version:
  - `candidates`: after the write step. Candidate count and each candidate's title.
  - `results`: after the score step. Per candidate: checks before and after where known, and the round's cost so far.
  - `decision`: after the decide step. The outcome (`merged`, `proposed`, `skipped`, `stopped`), the checks before and after, the round cost, total spend, and the stop reason as a word from the fixed list. This event carries the same fields as the round record the client sends today, so the service can treat it as the round's record.
  - `diagnostics`: see section 3.
- **Gated by the team's sharing choice** (section 4). `candidates` and `results` carry titles and numbers only. Anything beyond numbers follows the team's level, at every stage, not just the last one.
- **Scrubbed before sending.** Keys, tokens, emails and phone numbers are removed with the same patterns the round record uses today, on every field, at every stage.
- **Size caps.** A whole event stays under 256 KB. At the `full` level, any one text field stays under 100 KB.
- **Failure never blocks a round.** Each send has a 10 second timeout. A failed send prints one line in the step log (`Sharing skipped: ...`) and the round carries on. Events are best-effort: a missed stage event is not retried later, and the `decision` event stands on its own.

*Status: the `decision` event is shipped (it is today's end-of-round post from the decide step). The `candidates` and `results` stage events are the follow-on client work.*

## 3. Diagnostics

When a round fails, the error text sits in the team's workflow logs, where we cannot see it. A second, small workflow collects it.

- **File.** Init installs `.github/workflows/synthe-diagnostics.yml` next to `synthe.yml` (template in the appendix). `npx synthe upgrade` refreshes it the same way.
- **Trigger.** It runs when the Synthe workflow finishes, whatever the result: success, failure, or cancelled. It can also be run by hand.
- **What it collects.** The run's error artifacts (`write-error`, `score-error`, and the decide step's error file where present) and the job logs of the failed steps.
- **Scrubbed before anything leaves.** The same patterns as section 2, applied to every line collected. The workflow holds no key and no team code, and it never sends repo files other than the error artifacts Synthe itself wrote.
- **Where it goes.** The scrubbed bundle is uploaded as a workflow artifact named `synthe-diagnostics-<run id>`, kept 7 days. If the team's sharing level is not `none`, the workflow also posts a `diagnostics` event (section 2) with the run id, the result, and up to 4000 characters of the scrubbed error text.
- **Permissions.** `actions: read` and `contents: read`, nothing else. It does not check out or run the team's code. If diagnostics itself fails, nothing about the round changes, and no other step depends on it.

*Status: specified here. The template and the init wiring are follow-on client work.*

## 4. Sharing levels and the notice

- **Levels.** `none` sends nothing. `numbers` sends rounds, outcomes, checks, cost and stop reasons only. `detail` adds the goal, the checks, Synthe's prompt edits and one example message with its replies, never the whole prompt or the test-case file. `full` adds the prompt, the test cases and the final prompt, and exists only inside the event window: the window closes 2026-11-09T23:59:00Z (`FULL_SHARE_UNTIL` in `src/core/share.ts`; extended from November 8 to November 9 by the founders on 2026-11-04, before the event, so the notice teams see at setup names the real date), after which `full` behaves as `detail`.
- **The notice is part of this contract.** The text init shows before setup is the agreement the team acts on. Changing a word of it creates a new notice version. The version name is settled: `crimson-2026-11-v1`. Init records it in `synthe.json` as `share_notice`. Carrying it on every event as `notice` is follow-on work, held until the endpoint accepts the field.
- **Opt out any time.** `"share": "none"` in `synthe.json` stops all events from the next round on. `DO_NOT_TRACK=1` or `SYNTHE_TELEMETRY=0` at init turns sharing off from the start. The remove-my-data path is the service's side: deleting the team's issue in `synthelabs/synthe-feedback` (detail and full content) or `synthelabs/synthe-runs` (numbers).

*Status: levels and the window are shipped. The notice version is named and recorded at setup; the `notice` event field is follow-on work.*

## 5. Rules that do not change

- Sharing and diagnostics never block, slow, or fail a round.
- No secret ever leaves the repo in an event: not the team's key, not the team code, not tokens found in text. Scrub first, then send.
- Caps, windows and credit decisions live on the server. The client surfaces refusals plainly and never routes around them.
- Plain wording: events are "shared", records are tamper-evident at best, diagnostics are scrubbed logs. Nothing here is described as signed, proven, or audited.

## 6. Open items

- **Policy, settled 2026-11-04:** the notice is version `crimson-2026-11-v1`; the collection cutoff moved to November 9 23:59 UTC (client side in `FULL_SHARE_UNTIL`; the proxy's own end date is set on the service side). How long each level's data is kept after the event is deliberately not promised yet; no retention date is stated to teams until the founders settle one.
- **Client follow-on work:** the `candidates` and `results` stage events (section 2), the diagnostics template and init wiring (section 3), and the `notice` field once the name is settled (section 4).

## Appendix: synthe-diagnostics.yml template

```yaml
# Added by `npx synthe init`. Collects Synthe's error logs after a round, scrubbed, so the Synthe team can see why a
# round failed. Stop any time by deleting this file.
name: Synthe diagnostics
on:
  workflow_run:
    workflows: ["Synthe"]
    types: [completed]
  workflow_dispatch:
permissions: {}
jobs:
  collect:
    # Failed and cancelled runs included: those are the ones with something to collect.
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion != 'success' }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions: { actions: read, contents: read }
    steps:
      - uses: actions/download-artifact@v4
        continue-on-error: true
        with:
          run-id: ${{ github.event.workflow_run.id || github.run_id }}
          github-token: <redacted>
          path: .synthe-diagnostics
      # Scrub with the same client the round events use, then upload. A failure here changes nothing.
      - uses: __ACTION__
        with:
          step: diagnostics
          github-token: <redacted>
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: synthe-diagnostics-${{ github.event.workflow_run.id || github.run_id }}, path: .synthe-diagnostics, retention-days: 7, if-no-files-found: ignore }
```
