# No-spend readiness — November 4, 2026

This is an operator checklist, not a participant card. No real model calls, releases, workflow dispatches or deployment changes are authorized by these steps.

## Release audit

Initial snapshot verified against GitHub and npm on November 4, before the readiness follow-up commits were pushed to PRs #14 and #2:

| Surface | Observed state | Consequence |
| --- | --- | --- |
| npm `synthe` latest | `1.6.1` | `npx synthe@latest` does not deliver the new event/agent setup flow yet. |
| Remote Action `v1` | `e8a986811e6e4fd4480c331ece39b21bd01b4c1a` (`1.6.1`) | Existing workflows do not get the PR's event changes yet. |
| Remote `main` and `v1.6.2` | `ffcf7e32061969ef430c80f5f8f1c04979976ad9` | The existing `v1.6.2` tag predates the event changes. Moving `v1` to that tag alone will not ship them. |
| Synthe PR #14 | Open, head `19ba76b5240dcf66a1c0452944d305e58fa7a585`, mergeable | Event/agent changes remain on `proxy-agent`, five commits ahead of main. |
| Proxy PR #2 | Open, head `50af26494fa5f202b40c708549e04ce7d75560c0`, mergeable | The proxy branch is not merged. Production deployment was not verified in this audit. |
| GitHub checks | No status checks returned for either PR | Mergeable does not mean CI passed; use recorded local test results and required human review. |

Before publishing, merge the reviewed changes and choose a release version/tag that actually contains them. Prefer a fresh version rather than silently rewriting the existing `v1.6.2` tag. Verify the built artifacts and npm package contents, then have the owner publish and move `v1` to the intended release commit. Do not print participant QR cards claiming the new flow is live until both entry points are verified. `scripts/go-live.sh` is an old bootstrap script that pushes, force-moves `v1` and dispatches paid work; do not use it for this checklist.

## Offline setup rehearsal

Run from the Synthe checkout, using installed dependencies:

```
npm run typecheck
npm run build
npm test
```

The tests use injected models, command stubs and loopback HTTP servers. They exercise the real setup logic without a real Anthropic key or GitHub mutation. They are not a timed stranger test or evidence that GitHub permissions/OIDC work in production.

- Confirm `test/review.test.ts` covers event credential precedence, agent draft/confirmation, sharing opt-outs, failed-confirm retry and refusal of duplicate installed setup.
- Confirm `test/proxy.test.ts` covers local install identifiers, Action OIDC forwarding, credit refusals and persistent chain stops.
- Confirm own-key tests reject noninteractive app-key fallback, preserve the first switch's budget offset and do not suggest switching keys to reset an exhausted own-key budget.
- Confirm `test/e2e.test.ts` passes against local fake GitHub and model endpoints.
- From the proxy checkout, run `npm run smoke:ledger` and `npm test`. These use fake upstream responses and in-memory production Lua, not real model calls.
- Do not run `init`, `try`, `calibrate`, `key`, `go-live.sh` or dispatch an installed workflow against real credentials during this no-spend pass. Even key validation can call the model.

## Smaller-budget configuration draft

The owner reports about $42 in API credit. That is not permission to spend it, and it is not a verified dedicated workspace balance. The original $200 plan is not required for preparation.

One possible later event allocation is below; **not applied**:

```
EVENT_TOTAL_USD=30
SETUP_TOTAL_USD=5
PER_ACCOUNT_USD=2
SETUP_PER_INSTALL_USD=0.25
```

The $5 setup pool is included in the $30 event pool, not added to it. Nominally this leaves $12 of the reported balance unallocated, before any pending/other charges. Recheck available credit, set a dedicated workspace limit, and choose limits explicitly before enabling credit. Reservation headroom can refuse a request even when some credit remains. The setup allowance may need tuning after a separately authorized live test. Match all participant-facing dollar amounts to the chosen caps before printing; the current kit promises $4 per account. No configuration or participant allowance changes were made in this pass.

## Later checks that remain gated

- Connect a Redis database; run the isolated `smoke:ledger -- --redis` procedure in the proxy README. This needs no Anthropic key, but may consume billable Redis commands.
- Verify the dedicated workspace cap and proxy environment, choose an event code, and deploy only with owner authorization.
- Verify agent setup from the actual published package, then merge its setup PR and verify round one starts with real GitHub OIDC.
- Authorize a small API test budget separately; exercise one real response and a deliberately low cap, then the own-key switch if wanted.
- Give a stranger only the final QR card, time setup and record where they ask for help. Do not call the mocked rehearsal a successful stranger test.

## Recorded offline validation

- Synthe: typecheck and build passed; rebuilt `dist/cli.js` and `dist/action.mjs` include the local readiness fixes. All 264 tests passed.
- Targeted review mutation checks: 23/23 deliberately broken variants were caught. Before committing the readiness follow-up, the full `npm run mutation` suite also caught all 101/101 deliberately broken variants. Sources were restored before the final build and full test suite.
- Package dry run: five expected files (license, README, bundled CLI, package metadata and workflow template); no secrets or local setup drafts in the file list. Nothing was published.
- Proxy: all 60 tests passed, including three new smoke-runner tests. All six standalone ledger smoke scenarios passed with in-memory Redis. No hosted Redis test was run.
- The proxy concurrency test no longer assumes the last submitted JWT request finishes verification last; it checks the first completed refusal and always releases its upstream gate. This fixes an intermittent test deadlock without changing production behavior.
- The proxy has no configured typecheck script or local Node type definitions. A diagnostic check using the adjacent Synthe compiler and explicit Node types still reports three existing test typing errors (`test/fake-store.ts:50`, `test/proxy.test.ts:436`, `test/proxy.test.ts:442`). Runtime test success is not a clean proxy typecheck. Those unrelated typing issues were not changed.
- No Anthropic API requests, real workflow dispatches, commits, pushes, tag changes, releases or production configuration changes were made during the initial offline pass. The owner subsequently authorized committing and pushing these fixes to the existing PR branches for review; that does not authorize merging, releasing or deploying them.

## Independent review disposition

- Fixed repeated interactive setup overwriting an installed default branch, and rejected stale prompt confirmation with an explicit redraft message.
- Guarded `key` outside initialized folders and checked the remote setup before model validation, so missing setup does not spend a validation request.
- Fixed exhausted setup-credit advice to distinguish initialized teams (`key`) from new teams (`init` with their own key).
- Aligned the client's Haiku long-context accounting with the proxy's existing tier logic; this is an internal consistency check, not a new provider-pricing verification.
- Added event-secret teardown advice and clarified noninteractive key switching and first-switch-only budget offsets.
- Corrected the release finding: remote `v1` exists but is stale, rather than missing. Publishing and moving tags remain gated.
- The shared setup-pool bottleneck remains a deployment planning constraint: `init`, local `try` and `calibrate` all draw from that pool. Documented it rather than silently changing the funding policy.

## Participant/table fallback rehearsal

Practice the explanations without entering credentials or starting runs:

- Wrong event code: check the card/table; do not ask for our upstream Anthropic key.
- Exhausted event/account credit: explain the refusal; a team may choose `npx synthe key` in its own terminal, which uses its own paid account and validates the key.
- Workflow authentication failure: update the Synthe workflow; do not blame or rotate a valid Anthropic key.
- App deploys from the default branch: choose review mode; automatic merges can trigger that deployment.
- Sharing: show the full notice and the opt-out before confirming. Never present event credit as requiring sharing.
- Stop: explain `npx synthe stop`; do not execute it against a participant repo as a rehearsal.
