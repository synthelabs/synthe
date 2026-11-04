# Set up Synthe through a coding agent

Show the person the sharing notice, proposed checks, full example replies and
Synthe's marks before confirming. Ask what they mean; do not guess their goal,
merge mode, checks or agreement with the marks.

First, ask the person to supply `SYNTHE_EVENT_CODE` or their own
`SYNTHE_ANTHROPIC_KEY` / `ANTHROPIC_API_KEY` in the environment. Never put a
credential in a command flag, transcript or committed file. If GitHub CLI is not
ready, ask them to run `gh auth login` in their terminal once.

## Step 1: prepare, without changing the project

`npx synthe init --agent --prompt prompt.md --objective "Answer returns questions correctly" --mode review`

- `--prompt <path>`: tracked prompt file or code file containing one system prompt.
- `--objective "one sentence"`: the person's goal; required, no default.
- `--mode auto|review`: the person's choice; required, no default.
- `--message "real customer message"`: optional, repeat up to five times.
- `--check "sentence"`: optional starting checks, repeat up to five times.

This writes only `.synthe/setup-draft.json`. It does not commit, push, set secrets
or start rounds. Do not commit the draft. Follow the printed `NEXT:` instructions.

## Step 2: confirm the person's final checks

`npx synthe init --agent --confirm --check "Answers the user's returns question"`

Repeat `--check` for each final check. Or, only if the person keeps every proposed
check, run `npx synthe init --agent --confirm --keep-checks`. Keep the credential
environment from step 1. Confirmation adds the goal, scenarios and workflow,
sets the repository secret, commits and pushes setup (or opens a setup PR), and
starts round 1 once setup reaches the default branch. Watch the
**Synthe: prompt report** issue and the printed GitHub Actions URL.

To replace event credit with the person's own key later: `npx synthe key`.
If credit stopped the run, follow it with `npx synthe restart`.
