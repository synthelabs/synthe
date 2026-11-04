# PR 14 review fixes

## 1. Credential precedence and disclosure

Interactive setup, agent drafting and agent confirmation choose `SYNTHE_ANTHROPIC_KEY`, then `SYNTHE_EVENT_CODE`, then `ANTHROPIC_API_KEY`. Local model commands use the same precedence. Interactive input can explicitly replace a rejected credential.

Exact credential notices (the selected one is printed before scenario generation):

- `Credential: Crimson Hacks event code, $4 budget.`
- `Credential: your own key from SYNTHE_ANTHROPIC_KEY, $3 budget on your Anthropic account.`
- `Credential: your own key from ANTHROPIC_API_KEY, $3 budget on your Anthropic account.`
- `Credential: your own Anthropic key, $3 budget on your Anthropic account.` (a pasted key)

Exact agent handoff:

> NEXT: Tell the person which credential and budget will be used. Show all of this to the person, including the sharing notice, proposed checks and calibration examples. Ask which checks to keep or reword and whether the marks look right. The person can choose `--share none`. Then run `npx synthe init --agent --confirm --check "final sentence"`, repeating `--check` for each final check, or use `--keep-checks` if they keep the proposed checks.

## 2. Sharing at confirmation

`--share none|numbers|detail` changes the draft choice. Omitting it preserves the draft. `DO_NOT_TRACK=1|true` and `SYNTHE_TELEMETRY=0|false` override sharing at either step, including explicit `--share detail` at confirmation. Values are case-insensitive for the environment opt-outs.

Exact off notice:

> Sharing with Synthe: off (DO_NOT_TRACK, SYNTHE_TELEMETRY or --share none).

Exact numbers-only notice:

> Sharing with Synthe: numbers only (rounds, checks and spend). To turn sharing off, set "share": "none" in synthe.json, set DO_NOT_TRACK=1 on setup (including --confirm), or choose --share none in agent mode.

The full/detail notices retain their existing payload descriptions. Their new opt-out endings are:

> To turn sharing off, set "share": "none" in synthe.json (any time), set DO_NOT_TRACK=1 on setup (including --confirm), or choose --share none in agent mode.

> To turn it off, set "share": "none" in synthe.json (any time), set DO_NOT_TRACK=1 on setup (including --confirm), or choose --share none in agent mode.

## 3. Own-key budget and restart

`synthe key` writes `ownKeyFromUsd = spendUsd` to `state.json` on `synthe/state`, using the Contents API and current SHA just as restart does. If there has not been a round yet, it creates the state branch/file. Budget checks and reported budget spend subtract that offset; historical round spend stays intact. A budget stop resumes after a switch or after raising `budget.max_usd`, but the new budget still stops the run when exhausted. Failed rounds cannot bypass an exhausted budget.

Exact key success notice, with the configured dollar amount substituted:

> Rounds now use your own Anthropic key, with a fresh $4 budget (budget.max_usd in synthe.json). Run `npx synthe restart` to continue.

The final restart sentence is omitted if the run is not stopped.

Exact restart refusal at an exhausted $4 budget:

> Synthe has used its whole $4 budget. Run `npx synthe key` for a fresh own-key budget, or raise budget.max_usd in synthe.json and push it, then run `npx synthe restart`.

Exact budget-stop report next step:

> Run `npx synthe key` for a fresh own-key budget, or raise budget.max_usd in synthe.json and push it, then run `npx synthe restart`.

## 4. Key validation and closed stdin

Without an environment key and a TTY, `key` returns failure (the CLI exits 1), without prompting or writing anything:

> Ask the person to run `npx synthe key` in their own terminal.

When the app-key fallback is selected:

> Using the key in ANTHROPIC_API_KEY.

Non-Anthropic keys are rejected before a test call:

> That doesn't look like an Anthropic key: it must start with sk-ant-. Nothing changed.

A five-token Haiku call validates the key before reading/writing GitHub state or saving a secret. Failure prints the model problem followed by ` Nothing changed.` and leaves secrets and state untouched.

## 5. Failure guidance

Exact own-key messages:

- Your Anthropic key was rejected. Run `npx synthe key` to replace it.
- Your Anthropic key has no credit left. Run `npx synthe key` to replace it.
- Your Anthropic key has reached its spending limit. Run `npx synthe key` to replace it.
- Your Anthropic key isn't allowed to use this model. Run `npx synthe key` to replace it.

The decide step retains the cause and directs the person to `npx synthe key`, not the table or `gh secret set`.

Exact proxy 401 message (also used for missing Action OIDC configuration):

> The Synthe proxy couldn't verify this GitHub run. Run `npx synthe upgrade`, commit the workflow, and try again.

Proxy 503 preserves the server's message verbatim and remains a retryable busy failure:

> Credit is unavailable. Ask at the Synthe table.

Proxy 429 is a busy failure with the exact message:

> Synthe's proxy is busy. Wait a few minutes and try again.

Reports preserve proxy-specific messages instead of blaming Anthropic. The credit-stop next step is always present, even if the proxy's message contains no advice:

> To use your own Anthropic key, run `npx synthe key`, then `npx synthe restart`.

## 6. Interactive credential recovery

Credential selection and its cheap validation now precede the goal, messages and merge-mode questions. A mistyped code can be corrected inside the three-attempt loop without repeating the setup answers. Three failures end with:

> Nothing in your repo was changed. Run `npx synthe init` again when you have a working event code or key.

## 7. OIDC and retries

In event mode, Action write/score steps check both OIDC environment variables before GitHub/model work and use the proxy-401 upgrade message above. OIDC JWTs are cached by audience and request credentials until 60 seconds before their `exp`; opaque/non-JWT tokens are not cached. Proxy SDK retries are two; own-key retries remain four. Proxy SDK debug logging is disabled, including when `ANTHROPIC_LOG=debug`, so its custom event header is not logged by the SDK.

## 8. Repeated setup and draft hygiene

Successful confirmation deletes `.synthe/setup-draft.json`. The setup commit adds `/.synthe/setup-draft.json` to the **team's `.gitignore`**, preserving existing ignore contents; the draft itself is never explicitly staged. Drafting or confirming an installed default branch returns failure with:

> Synthe is already set up on the default branch. Use `npx synthe restart` to continue; don't run init again.

## 9. Agent-only output

Agent mode no longer prints the interactive optional-message paste/Enter prompt. Explicit `--message` inputs still seed scenario generation.

## Additional wording

`kit/HACKATHON.md` now says:

> **What it costs you:** nothing with the event code. $4 of event credit per GitHub account (shared by all your repos); the proxy caps event spend.

The final wording in `docs/AGENT-SETUP.md` is preserved except for behavior-dependent credential, sharing, draft and budget instructions.

## Regression and mutation coverage

`test/review.test.ts` adds 14 regression tests (with table-driven cases) for the findings above. Existing init, failure and restart expectations are updated for intentionally changed behavior.

Only the new mutation suite is run: `node scripts/review-mutations.mjs`. It first checks the unmutated regression baseline, then checks 20 mutations and restores every source file. All 20 are killed, including the three previously surviving defects: accepting non-`sk-ant-` keys, dropping credit-report next steps and skipping the step-2 credential-type match.

Final validation order: new mutations, `npm run build`, then `npm test` last. Both rebuilt distribution bundles are included. No merge, tag, package publication or main-branch push is performed.

Final results: **258 tests passed, 0 failed** (`ℹ fail 0`); **20/20 new mutations killed**; build and TypeScript checking succeeded.
