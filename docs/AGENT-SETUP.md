# Set up Synthe (for coding agents)

Synthe is an open-source tool that improves an AI agent's system prompt automatically. It runs as a GitHub Action in this repo. Each round it writes candidate edits to the prompt, tests them on simulated customer messages against the team's "checks" (plain sentences describing a good reply), and keeps the winner. In auto mode the winner is merged into main. In review mode it opens a PR.

You are talking to a person at Crimson Hacks (Nov 6-8, 2026) who may never have used a terminal. Use plain words. Do the steps in order.

## Rules

- Never invent the goal, the checks or the mode. Ask the person.
- Never edit `synthe.json`, `.synthe/` or the workflow file by hand.
- If a command fails, show the person the exact message and follow what it says.
- Do not retry setup more than once without asking the person.
- Setup is two commands: draft (step 5) and confirm (step 7). Synthe is not installed until confirm succeeds. The draft writes only a local file: no workflow, no secrets, no commit. Finish confirm before you do any other work in this repo.
- If the person asks for something else before confirm (for example "implement it" or a change to their code), tell them: "Synthe is not installed yet. One more command finishes it." Finish confirm first, then do what they asked.
- Do not edit the prompt file between draft and confirm. Confirm refuses a prompt that changed, and nothing is installed.

## 1. Prerequisites

1. Use `git remote -v` and `git status` to check that the repo is on GitHub and pushed. Commit and push the agent's prompt file too. Setup checks that it matches the copy on GitHub's default branch before drafting.
2. Check the GitHub CLI:

```
gh auth status
```

3. If `gh` is missing or not logged in, ask the person to run `gh auth login` in their own terminal and finish the browser login. You cannot do this for them. Wait until they say it is done, then run `gh auth status` again.

## 2. Credit

1. Ask the person for the Crimson Hacks event code from the QR card and their team code from the Synthe table. Enrolled teams need both codes for workflow tracking, even if they use their own Anthropic key. A setup outside the event can use its own Anthropic key alone.
2. Your commands may each run in a fresh shell, so an `export` in an earlier command or in the person's own terminal may not reach you. Put the code at the front of each Synthe command instead (steps 5 and 7):

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.3 init --agent ...
```

3. An own key is a real secret. If the person uses one, tell them it will appear in this chat and in the command, and that after setup they can run `npx synthe key` in their own terminal to replace it. Never write a code or key to a file. Never commit it.

Agent setup uses `SYNTHE_ANTHROPIC_KEY` first, then `SYNTHE_EVENT_CODE` with `SYNTHE_TEAM_CODE`. Both draft and confirmation refuse an `ANTHROPIC_API_KEY`-only environment; the app's key is never silently used by an agent. Ask the person which explicit Synthe credential to use. Show the printed credential and budget so they know whose credit will be used.

## 3. Find the system prompt

1. Search the code for the agent's system prompt. It is a `.md` or `.txt` file, or a string in code.
2. Show the person the path and the first few lines. Ask: "Is this the prompt you want to improve?" Wait for a yes. If it is wrong, look again.

## 4. Ask the person (never guess any of these)

1. What should the agent get better at? One sentence.
2. Optional: 3 to 5 real messages a user might send to the agent.
3. Which mode?
   - Auto: improvements merge into main by themselves.
   - Review: each improvement waits as a PR for the person to approve.

## 5. Step 1: draft

Run this. It writes a local draft and immediately adds its ignore entry to `.gitignore`. It does not stage, commit or push anything.

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.3 init --agent --prompt <path> --objective "<sentence>" --mode auto|review --message "<msg>" --message "<msg>"
```

To use an own key during Crimson, add `SYNTHE_ANTHROPIC_KEY=<key>` alongside both event codes, here and in step 7. Outside Crimson, use the own key alone.

Use `--mode auto` or `--mode review` as the person chose. Leave out `--message` if they gave none.

## 6. Show the person everything step 1 printed

Show the full output as written, not a summary. It has three parts:

1. The credential and budget, the sharing notice, and the Crimson workflow notice for enrolled teams. Show the notices as information. They need no answer. Enrolled Crimson workflows send the organizers the repository and run IDs, attempt, timing, and outcome. Separate research-sharing settings control the prompt, test cases, and other research data.
2. The numbered proposed checks.
3. Example replies, each with Synthe's pass or fail mark.

Then ask the person:

- Which checks to keep, drop or reword?
- Do the pass/fail marks on the example replies look right? If a mark looks wrong, the check probably needs rewording.
- If step 1 said some checks can't both pass on the same reply, show that pair and why, and offer to reword one of them. Keeping both is allowed; Synthe just can't raise that score.

Follow the `NEXT:` line with the tagged command in step 7. Do not start other work until step 7 succeeds.

## 7. Step 2: confirm

Run this with one `--check` per check the person kept, using their final wording:

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.3 init --agent --confirm --check "<final sentence>" --check "<final sentence>"
```

If the person accepted every proposed check as it is, run this instead:

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.3 init --agent --confirm --keep-checks
```

Setup ignores `.synthe/setup-draft.json` before writing it and deletes the draft after success. It leaves `.gitignore` changes local and out of its setup commit, preserving any unrelated staged or unstaged edits; the person can commit that ignore entry deliberately. Don't confirm twice.

Confirm succeeded only if it printed `Added to <branch>` or opened an "Add Synthe" pull request. If it printed anything else, show the person the message, follow it, and do not go to step 8. If it opened a pull request, Synthe starts only after that pull request is merged: tell the person.

## 8. After setup

Do this step only after confirm succeeded. Tell the person:

- Rounds start by themselves. They do not need to do anything.
- To watch progress, open the GitHub issue titled "Synthe: prompt report" and the repo's Actions tab.
- Tell the person: 'Ask me "what did Synthe do?" at any time and I will show you what changed.'
- When the person asks what Synthe did or what changed, run `npx synthe changes` and show its output word for word before adding any commentary of your own.
- Useful commands:

```
npx synthe status
npx synthe changes
npx synthe stop
npx synthe key
```

  - `status` shows how things are going.
  - `changes` shows what Synthe changed in the latest rounds and how the prompt's score moved.
  - `stop` stops Synthe; nothing more runs or changes. `npx synthe restart` starts it again.
  - `key` tests and switches to their own Anthropic key, with a fresh `budget.max_usd` budget counted from the first switch only. Replacing the key later does not reset that budget. Ask the person to run it in their own terminal; an agent cannot answer its secret prompt in a noninteractive shell. Use it when the event credit runs out, then run `npx synthe restart` if stopped. A budget stop can also be resumed by raising `budget.max_usd` in `synthe.json` and pushing. The printed local run budget is not an event-credit allowance. Organizer-configured caps and shared availability may stop the run sooner; do not promise a fixed dollar amount of event credit.
