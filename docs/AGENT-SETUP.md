# Set up Synthe (for coding agents)

Synthe is an open-source tool that improves an AI agent's system prompt automatically. It runs as a GitHub Action in this repo. Each round it writes candidate edits to the prompt, tests them on simulated customer messages against the team's "checks" (plain sentences describing a good reply), and keeps the winner. In auto mode the winner is merged into main. In review mode it opens a PR.

You are talking to a person at Crimson Hacks (Nov 6-8, 2026) who may never have used a terminal. Use plain words. Do the steps in order.

## Rules

- Never invent the goal, the checks or the mode. Ask the person.
- Never edit `synthe.json`, `.synthe/` or the workflow file by hand.
- If a command fails, show the person the exact message and follow what it says.
- Do not retry setup more than once without asking the person.

## 1. Prerequisites

1. Check the repo is on GitHub and pushed: `git remote -v` and `git status`. If not, help the person push it first.
2. Check the GitHub CLI:

```
gh auth status
```

3. If `gh` is missing or not logged in, ask the person to run `gh auth login` in their own terminal and finish the browser login. You cannot do this for them. Wait until they say it is done, then run `gh auth status` again.

## 2. Credit

1. Ask the person for the Crimson Hacks event code from the QR card. Or they can use their own Anthropic key (it starts with `sk-ant-`).
2. Your commands may each run in a fresh shell, so an `export` in an earlier command or in the person's own terminal may not reach you. Put the code at the front of each Synthe command instead (steps 5 and 7):

```
SYNTHE_EVENT_CODE=<code> npx synthe@latest init --agent ...
```

3. An own key is a real secret. If the person uses one, tell them it will appear in this chat and in the command, and that after setup they can run `npx synthe key` in their own terminal to replace it. Never write a code or key to a file. Never commit it.

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

Run this. It changes nothing in the repo except a draft file.

```
SYNTHE_EVENT_CODE=<code> npx synthe@latest init --agent --prompt <path> --objective "<sentence>" --mode auto|review --message "<msg>" --message "<msg>"
```

With an own key, use `SYNTHE_ANTHROPIC_KEY=<key>` in place of `SYNTHE_EVENT_CODE=<code>`, here and in step 7.

Use `--mode auto` or `--mode review` as the person chose. Leave out `--message` if they gave none.

## 6. Show the person everything step 1 printed

Show the full output as written, not a summary. It has three parts:

1. The sharing notice. The person must see it. During Crimson Hacks, Synthe shares the prompt and test cases with the Synthe team until Nov 8. Never code. Secrets are removed. Setting `"share": "none"` in `synthe.json` turns sharing off.
2. The numbered proposed checks.
3. Example replies, each with Synthe's pass or fail mark.

Then ask the person:

- Which checks to keep, drop or reword?
- Do the pass/fail marks on the example replies look right? If a mark looks wrong, the check probably needs rewording.

Follow the `NEXT:` line that step 1 printed.

## 7. Step 2: confirm

Run this with one `--check` per check the person kept, using their final wording:

```
SYNTHE_EVENT_CODE=<code> npx synthe@latest init --agent --confirm --check "<final sentence>" --check "<final sentence>"
```

If the person accepted every proposed check as it is, run this instead:

```
SYNTHE_EVENT_CODE=<code> npx synthe@latest init --agent --confirm --keep-checks
```

## 8. After setup

Tell the person:

- Rounds start by themselves. They do not need to do anything.
- To watch progress, open the GitHub issue titled "Synthe: prompt report" and the repo's Actions tab.
- Useful commands:

```
npx synthe status
npx synthe stop
npx synthe key
```

  - `status` shows how things are going.
  - `stop` stops Synthe; nothing more runs or changes. `npx synthe restart` starts it again.
  - `key` switches to their own Anthropic key. Use it when the event credit runs out. Each GitHub account gets $4 of event credit.
