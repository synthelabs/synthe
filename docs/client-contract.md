# The client contract

What the Synthe client (the `synthe` npm package and the workflows it installs in a team's repo) promises the Synthe services, and what it expects back. The services live in `synthelabs/synthe-share`. When a behaviour here changes, both repos change in the same release, and this file is updated in the same pull request.

Services:

- **Sponsored model credit:** `POST https://synthe-crimson.vercel.app/api/claude/v1/messages`
- **Round events (private ingest):** `POST https://synthe-crimson.vercel.app/api/events`
- **Diagnostics (private ingest):** `POST https://synthe-crimson.vercel.app/api/diagnostics`
- **Round summaries (the older, numbers-only path, still live):** `POST https://synthe-share.vercel.app/api/round`

The ingest endpoints and the team-credit mode are built on the synthe-share branches `crimson/team-enrollment` and `crimson/private-ingest`, stacked on PR #2 (synthe-share PRs #3 and #4). Rishab's copy of this contract lives on the ingest branch; this copy was reconciled against it line by line on 2026-11-04. Where the two copies differ, the ingest branch's copy wins until this one is reconciled again.

Each section ends with its build status, so nobody mistakes a plan for a shipped behaviour.

## 1. The team code (`CREDIT_MODE=team`)

At an event, each team gets one team code (on their QR card at Crimson Hacks), shaped `crim-xxxx-xxxx-xxxx-xxxx`. The code is how the sponsored credit knows which team is calling. Organizers issue the codes; the server stores only a hash of each code. One ledger per team covers setup and rounds together, and every repo the team runs shares that one allowance.

- **Asked once.** `npx synthe init` asks for the code during setup, with typed input hidden. The client normalises it: trim, lowercase, remove spaces. A team with its own Anthropic key can skip it and never uses the proxy. The code never goes in argv, URLs, logs or `synthe.json`.
- **Stored privately.** Init stores the code at the same private local credential path PR #14 uses for the event code, and as the repo secret `SYNTHE_TEAM_CODE`, beside the existing event-code secret.
- **Sent on every proxy call.** Local setup, `try` and `calibrate` calls send `x-synthe-team` together with `x-synthe-event` and `x-synthe-install`. Action rounds send `x-synthe-team` together with `x-synthe-event` and the `synthe-proxy` OIDC bearer token. The team code does not replace the event code; both are sent.
- **Refusals.** Proxy auth refusals are HTTP 403 with `error.type = "synthe_proxy_auth"`: missing or malformed code, unknown code, revoked code, or a repo already linked to another team. The client shows the server's message as-is, and asks for the code again only when it was missing or unknown. Workflow-upgrade guidance stays with HTTP 401 only; it is never shown for these. Credit refusals are HTTP 402 with `error.type = "synthe_credit"`, and mean only that this request's hold does not fit, not necessarily that the team's $4 is gone. All dollar caps live on the server; the client never guesses, shows, or works around them.
- **No quiet fallback.** The client never falls back to a team's own key (environment or stored) on its own. `npx synthe key` is offered as an explicit choice only.
- **Independent of sharing.** The sharing choice does not change proxy behaviour: `share: "none"` teams still call the proxy the same way.

*Status: the service side is built and tested offline on the enrollment branch (`CREDIT_MODE` must be set explicitly; `CREDIT_MODE=owner` is the fallback that works with the client exactly as PR #14 ships it). The client's team-code wiring is follow-on work on top of PR #14: the private storage and the install header already exist there; the `x-synthe-team` header, the `SYNTHE_TEAM_CODE` secret and the refusal handling are the new parts. Neither side merges alone.*

## 2. Round events

So the team can see a round while it happens, and so a stuck round is visible to us, the round workflow (`.github/workflows/synthe.yml`) sends events to `POST /api/events`. The server enforces the team's consent, the notice version and the collection cutoff on every event, whatever the client sends.

- **Identity.** The job requests a GitHub OIDC token with audience `synthe-events` and sends it as `Authorization: Bearer <token>`. The server takes the repository, repository id, run id and attempt from the token, never from the body. Accepted triggers: `workflow_dispatch`, `schedule`, and same-repo `pull_request` (merge ref). The job needs `permissions: id-token: write`.
- **Envelope.** One POST carries a batch: at most 192 KiB, at most 50 events.

```json
{
  "schema": 1,
  "share": "full",
  "notice": "crimson-2026-11-v1",
  "synthe_version": "1.7.0",
  "source_sha": "<40-hex commit of the prompt repo>",
  "install_id": "<optional PR14 install UUID>",
  "events": [{ "id": "<uuid v4, stable across retries>", "kind": "candidate", "at": "2026-11-06T20:00:00Z", "stage": "write", "data": {} }]
}
```

- `at` is a strict UTC timestamp (optional fractional seconds). `stage` is one to four short lowercase words.
- **Kinds.** `setup`, `round_start`, `candidate`, `case_result`, `decision`, `round_end`, `no_op`, `failure`, `cancel`, `stop`, `final_prompt`, `human_judgment`.
- **Suggested `data` at the full level** (unavailable fields are `null`, never invented):
  - `candidate`: `candidate_id`, `parent_prompt_sha256`, `diff` (the exact edit), `prompt` (the resolved candidate prompt), `writer_rejection`, `scored` (whether it reached scoring).
  - `case_result`: `candidate_id`, `case_id`, `split` (`train` or `holdout`), `baseline_output`, `candidate_output`, `baseline_score`, `candidate_score`, `failed_checks`, guard and attack results.
  - `decision`: `candidate_id`, `accepted`, `reasons`, `noise`, `calibration`.
  - `round_end`: `outcome`, `no_op_reason`, `pr`, `commit`, `cost_usd`, `final_prompt_sha256`.
  - `setup`: replayed by the workflow from a sanitised local artifact (local machines never upload directly): stage, objective, checks, generated cases with train/holdout labels.
- **Gated by the team's sharing choice.** `share` in the envelope is the effective choice read from the default branch. `none` sends nothing (the server returns 403). At `numbers` and `detail`, `data` may hold only numbers, booleans, null, and one to four lowercase words without digits (`/^[a-z_-]{1,16}( [a-z_-]{1,16}){0,3}$/`): no prompts, ids or text. At `full`, `data` is any JSON with lowercase snake_case keys and depth at most 6; it needs the accepted `notice` version, and the server refuses it after `FULL_UNTIL` by the server clock, after which the client resends as numbers.
- **Writer isolation.** Events are captured at the writer, scorer and decide boundaries. Research records, holdout cases, guards, attacks and evidence are never fed back into the writer's context.
- **Responses and retries.** A 200 returns `{ ok, results: { <event id>: "stored" | "duplicate" } }`. The client retries 409, 429 (honouring `retry-after`), 502 and 503 with backoff, at most about 5 attempts, reusing the same event ids. Other 4xx are not retried. A sharing failure must never fail the round.
- The older `/api/round` summary post keeps working; the ingest events are the fuller record for teams whose sharing level allows it.

*Status: the service side is built and tested offline on the ingest branch (120 tests, targeted mutations caught, review fixes in). The client's `/api/round` summary post is shipped; the `/api/events` sender is follow-on client work, and without it the new endpoint receives nothing.*

## 3. Diagnostics

When a round fails, the error text sits in the team's workflow logs, where we cannot see it. A second, small workflow collects it: `.github/workflows/synthe-diagnostics.yml`, installed by `init` and `upgrade` next to `synthe.yml`. It only runs once it is on the default branch (GitHub runs `workflow_run` workflows only from there); collection is not reported as active before that.

```yaml
name: Synthe diagnostics
on:
  workflow_run:
    workflows: [Synthe]           # must equal synthe.yml's `name:`
    types: [completed]
  workflow_dispatch:
    inputs: { run_id: { required: true }, attempt: { required: false, default: "1" } }
permissions: { actions: read, contents: read, id-token: write }
concurrency: { group: synthe-diagnostics-${{ github.event.workflow_run.id || inputs.run_id }}, cancel-in-progress: false }
jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      # No checkout of team code, no dependency install from the repo, no execution of downloaded artifacts.
      - uses: __ACTION__              # pinned released Synthe action, step: collect
        with: { step: collect, github-token: <redacted> }
```

The `collect` step is trusted released code. It:

1. Reads the effective `share` and `diagnostics` choice from `synthe.json` on the **default branch** via the contents API. Missing, invalid, `share: none`, or diagnostics off means upload nothing and exit 0. An old config with no `diagnostics` field means off.
2. Confirms the source run is `.github/workflows/synthe.yml` in this repository, and is not the collector's own run.
3. Lists the run's jobs (`GET /repos/{repo}/actions/runs/{id}/attempts/{attempt}/jobs`, paginated). For each job it fetches the logs with `redirect: "manual"`, then fetches the `Location` URL **without** the Authorization header, and only from GitHub's expected log hosts. It never forwards the token, signed URLs or raw event payloads.
4. Scrubs before anything leaves the runner: keys, tokens, Authorization and cookie headers, env and credential dumps, event and team codes, emails and phone numbers, signed URLs. If scrubbing or decoding fails, that job's log is withheld with a reason.
5. Splits each job log into chunks of at most 48 KiB of UTF-8 on line boundaries, at most 200 chunks per job and 5 MiB per run across all attempts (also 100 MiB per repository); anything beyond is marked `truncated`. Chunks upload one at a time; concurrent uploads of one run get 409.
6. Gets an OIDC token with audience `synthe-diagnostics` and posts to `POST /api/diagnostics`, chunks first and the manifest last:

```json
{ "schema": 1, "share": "full", "notice": "crimson-2026-11-v1", "synthe_version": "1.7.0", "source_sha": "<40 hex>",
  "diagnostics": "full",
  "run": { "id": "900", "attempt": "1", "workflow": ".github/workflows/synthe.yml", "conclusion": "cancelled", "event": "schedule", "created_at": "...", "updated_at": "..." },
  "chunk": { "job_id": "77", "job_name": "write", "index": 0, "total": 3, "sha256": "<sha256 of text>", "text": "..." } }
```

   The manifest replaces `chunk`: `"manifest": { "jobs": [{ "id": "77", "name": "write", "conclusion": "failure", "log": "uploaded", "bytes": 1234, "chunks": 1, "sha256": "<hex>", "reason": "optional short word" }], "limits": { "chunk_bytes": 49152 } }`. A job's `log` is one of `uploaded`, `empty`, `skipped`, `unavailable`, `redacted`, `truncated`, `failed`. The server works out complete, partial or unavailable itself, and marks a job complete only if it stored every declared chunk, which is why the manifest goes last. With `diagnostics: "summary"` (or a share level other than `full`) only the manifest is sent, with job names replaced by ids.
7. Uses the same retry policy as events. The sanitised chunks are kept as a short-retention artifact so a manual `workflow_dispatch` with a `run_id` can backfill. A 410 response means the team asked for deletion: stop, and never resend.

*Status: the endpoint is built and tested offline on the ingest branch (per-job logs, including from failed, cancelled and timed-out runs). The template and the init wiring are follow-on client work.*

## 4. Sharing levels and the notice

- **Levels.** `none` sends nothing. `numbers` sends rounds, outcomes, checks, cost and stop reasons only. `detail` adds the goal, the checks, Synthe's prompt edits and one example message with its replies, never the whole prompt or the test-case file. `full` adds the prompt, the test cases and the final prompt, and exists only inside the event window: the window closes 2026-11-09T23:59:00Z (`FULL_SHARE_UNTIL` in `src/core/share.ts`; extended from November 8 to November 9 by the founders on 2026-11-04, before the event, so the notice teams see at setup names the real date), after which `full` behaves as `detail`.
- **The notice is part of this contract.** The text init shows before setup is the agreement the team acts on. Changing a word of it creates a new notice version. The version name is settled: `crimson-2026-11-v1`. Init records it in `synthe.json` as `share_notice`, and every events and diagnostics envelope carries it as `notice`.
- **Opt out any time.** `"share": "none"` in `synthe.json` stops all events from the next round on. `DO_NOT_TRACK=1` or `SYNTHE_TELEMETRY=0` at init turns sharing off from the start. The remove-my-data path is the service's side: deleting the team's issue in `synthelabs/synthe-feedback` (detail and full content) or `synthelabs/synthe-runs` (numbers).

*Status: levels and the window are shipped. The notice version is named and recorded at setup; carrying it on events ships with the events sender (section 2).*

## 5. Server settings this contract depends on

- `NOTICE_VERSIONS`: comma list of accepted notice versions. Unset means no full content is accepted.
- `FULL_UNTIL`: the server's full-collection cutoff. Its default in the ingest patches is `2026-11-08T23:59:00Z`; the deploy environment must set it to `2026-11-09T23:59:00Z` to match the settled policy, or the default must be changed before deploying.
- `GITHUB_TOKEN`: Issues read/write and Metadata read on `synthelabs/synthe-feedback`.
- `KV_REST_API_URL` / `KV_REST_API_TOKEN`: the bookkeeping store.
- `ADMIN_TOKEN`, `EVENT_CODE`: organizer operations and the older event-code path.

## 6. Rules that do not change

- Sharing and diagnostics never block, slow, or fail a round.
- No secret ever leaves the repo in an event: not the team's key, not the team code, not tokens found in text. Scrub first, then send.
- Caps, windows and credit decisions live on the server. The client surfaces refusals plainly and never routes around them.
- Plain wording: events are "shared", records are tamper-evident at best, diagnostics are scrubbed logs. Nothing here is described as signed, proven, or audited.

## 7. Open items

- **Policy, settled 2026-11-04:** the notice is version `crimson-2026-11-v1`; the collection cutoff moved to November 9 23:59 UTC (client side in `FULL_SHARE_UNTIL`; server side is the `FULL_UNTIL` deploy setting in section 5). How long each level's data is kept after the event is deliberately not promised yet; no retention date is stated to teams until the founders settle one.
- **Client follow-on work:** the team-code wiring (section 1), the `/api/events` sender in the round workflow (section 2), and the diagnostics template and init wiring (section 3).
