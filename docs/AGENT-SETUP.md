# Set up Synthe (for coding agents)

Synthe is an open-source tool that improves an AI agent's system prompt automatically. It runs as a GitHub Action in this repo. Each round it writes candidate edits to the prompt, tests them on simulated customer messages against the team's "checks" (plain sentences describing a good reply), and keeps the winner. In auto mode the winner is merged into main. In review mode it opens a PR.

You are talking to a person at Crimson Hacks (Nov 6-8, 2026) who may never have used a terminal. Use plain words. Do the steps in order.

Most teams set this up at the Synthe workshop, an hour or two into the hackathon, with their agent only partly built. That is fine: Synthe improves the prompt as it is now, and the team keeps building while it runs.

## Rules

- Never invent the goal, the checks or the mode. Ask the person.
- Never edit `synthe.json`, `.synthe/` or the workflow file by hand. One exception: after a run stops because nothing was clearly better, if the person wants it to keep going, you may add test cases to `.synthe/scenarios.jsonl` with them (see step 8).
- If a command fails, show the person the exact message and follow what it says.
- Do not retry setup more than once without asking the person.
- Setup is two commands: draft (step 5) and confirm (step 7). Synthe is not installed until confirm succeeds. The draft writes only a local file: no workflow, no secrets, no commit. Finish confirm before you do any other work in this repo.
- If the person asks for something else before confirm (for example "implement it" or a change to their code), tell them: "Synthe is not installed yet. One more command finishes it." Finish confirm first, then do what they asked.
- Do not edit the prompt file between draft and confirm. Confirm refuses a prompt that changed, and nothing is installed.

## 0. Which mode

First find out whether the app sends a system prompt to an AI model: a `.md` or `.txt` prompt file, or a prompt string passed to a model call. Look before you ask.

- **No AI prompt, or the person wants a code change measured by a number** (tests passing, bundle size, build time, or a command of theirs): use **improve mode**. Go to section 9 and skip sections 1 to 8. Synthe itself proposes and measures the code changes, so it needs the person's event code and team code, or their own Anthropic key (section 9, step 1). Without either, section 9 has a fallback where you make the change.
- **The app has a prompt and the person wants that prompt improved:** continue with section 1.

## 1. Prerequisites

1. Use `git remote -v` and `git status` to check that the repo is on GitHub and pushed. Commit and push the agent's prompt file too. Setup checks that it matches the copy on GitHub's default branch before drafting.
2. Check the GitHub CLI:

```
gh auth status
```

3. If `gh` is missing or not logged in, ask the person to run `gh auth login` in their own terminal and finish the browser login. You cannot do this for them. Wait until they say it is done, then run `gh auth status` again.

4. Be on the default branch (usually `main`) and run `git pull`, so teammates' latest pushes are in. Setup refuses to run on another branch.
5. Check that this person can set up Synthe in this repo:

```
gh repo view --json viewerPermission --jq .viewerPermission
```

It must print `ADMIN`. Setup saves repo secrets, which only admins can do. If it prints anything else, stop: the repo's owner must run setup, or make this person an admin (Settings, then Collaborators). Setup also stops by itself in that case, before it spends anything.

## 2. Credit

1. Ask the person for the Crimson Hacks event code from the QR card and their team code from the Synthe table. Enrolled teams need both codes for workflow tracking, even if they use their own Anthropic key. A setup outside the event can use its own Anthropic key alone.
2. Your commands may each run in a fresh shell, so an `export` in an earlier command or in the person's own terminal may not reach you. Put the code at the front of each Synthe command instead (steps 5 and 7):

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.9.1 init --agent ...
```

3. An own key is a real secret. If the person uses one, tell them it will appear in this chat and in the command, and that after setup they can run `npx synthe key` in their own terminal to replace it. Never write a code or key to a file. Never commit it.

Agent setup uses `SYNTHE_ANTHROPIC_KEY` first, then `SYNTHE_EVENT_CODE` with `SYNTHE_TEAM_CODE`. Both draft and confirmation refuse an `ANTHROPIC_API_KEY`-only environment; the app's key is never silently used by an agent. Ask the person which explicit Synthe credential to use. Show the printed credential and budget so they know whose credit will be used.

## 3. Find the system prompt

1. Search the code for the agent's system prompt. It is a `.md` or `.txt` file, or a string in code, that the app sends to an AI model.
2. Show the person the path and the first few lines. Ask: "Is this the prompt you want to improve?" Wait for a yes. If it is wrong, look again.
3. If you find no prompt because the app doesn't call an AI model yet (for example its logic is written as rules), stop here. Tell the person: "Synthe improves the prompt your app sends to an AI model. Your app doesn't call one yet, so there is nothing for Synthe to improve. Once your app uses an AI prompt, run setup again." Do not write a new prompt only so that Synthe has one to improve: the app would never use the changes. Connecting the app to an AI model is separate work; offer to help with it if the person asks.

## 4. Ask the person (never guess any of these)

1. What should the agent get better at? One sentence.
2. Optional: 3 to 5 real messages a user might send to the agent.
3. Which mode?
   - Auto: improvements merge into main by themselves.
   - Review: each improvement waits as a PR for the person to approve.

## 5. Step 1: draft

Run this. It writes a local draft and immediately adds its ignore entry to `.gitignore`. It does not stage, commit or push anything.

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.9.1 init --agent --prompt <path> --objective "<sentence>" --mode auto|review --message "<msg>" --message "<msg>"
```

To use an own key during Crimson, add `SYNTHE_ANTHROPIC_KEY=<key>` alongside both event codes, here and in step 7. Outside Crimson, use the own key alone.

Use `--mode auto` or `--mode review` as the person chose. Leave out `--message` if they gave none.

## 6. Show the person everything step 1 printed

Show the full output as written, not a summary. It has three parts:

1. The credential and budget, the sharing notice, and the Crimson workflow notice for enrolled teams. Show the notices as information. They need no answer. Enrolled Crimson workflows send the organizers the repository and run IDs, attempt, timing, and outcome. Separate research-sharing settings control the prompt, test cases, and other research data.
2. The numbered proposed checks.
3. Example replies, each with Synthe's pass or fail mark.

Then ask the person. If they chose auto mode, say first: "Auto mode is set. One last step before Synthe starts: approve the checks it will score replies with. This is not a merge approval; after this, improvements merge by themselves."

- Which checks to keep, drop or reword?
- Do the pass/fail marks on the example replies look right? If a mark looks wrong, the check probably needs rewording.
- If step 1 said some checks can't both pass on the same reply, show that pair and why, and offer to reword one of them. Keeping both is allowed; Synthe just can't raise that score.

Follow the `NEXT:` line with the tagged command in step 7. Do not start other work until step 7 succeeds.

## 7. Step 2: confirm

Run this with one `--check` per check the person kept, using their final wording:

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.9.1 init --agent --confirm --check "<final sentence>" --check "<final sentence>"
```

If the person accepted every proposed check as it is, run this instead:

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.9.1 init --agent --confirm --keep-checks
```

Setup ignores `.synthe/setup-draft.json` before writing it and deletes the draft after success. It leaves `.gitignore` changes local and out of its setup commit, preserving any unrelated staged or unstaged edits; the person can commit that ignore entry deliberately. Don't confirm twice.

Confirm succeeded only if it printed `Added to <branch>` or opened an "Add Synthe" pull request. If it printed anything else, show the person the message, follow it, and do not go to step 8. If it opened a pull request (usually because a teammate pushed to the default branch during setup), Synthe starts only after that pull request is merged. Ask the person to merge it now.

## 8. After setup

Do this step only after confirm succeeded. Tell the person:

- Rounds start by themselves. They do not need to do anything. A run is up to 12 rounds and takes up to about 30 minutes. It stops sooner, often within 5 to 10 minutes, when 3 rounds in a row find nothing clearly better than the current prompt. Either way it stops by itself.
- In auto mode, Synthe commits its improvements to the prompt file on the default branch. Everyone on the team should run `git pull` before they edit the prompt or push, so their work and Synthe's don't collide. Synthe always starts each round from the latest prompt on the default branch, so the team can keep changing it.
- To watch progress, open the GitHub issue titled "Synthe: prompt report" and the repo's Actions tab.
- Tell the person: 'Ask me "what did Synthe do?" at any time and I will show you what changed.'
- If the run stopped because nothing was clearly better and the person wants it to keep going: with them, write 3 to 5 new test cases their agent still gets wrong, show them, add each as one line to `.synthe/scenarios.jsonl` in the format the report shows (most with `"split": "train"`, about one in four `"holdout"`), commit and push, then run `npx synthe restart`. Change nothing else in `.synthe/`.
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

## 9. Improve mode (no AI prompt needed)

`npx synthe improve` is a loop. Synthe itself proposes one code change per round, through the event proxy or the person's own key. It measures each change in a throwaway checkout, next to the current code, the same way. It keeps a change only when it beats the best so far by more than the run-to-run noise and the regression check still passes. Each kept change builds on the one before. At the end it opens ONE pull request titled like `Synthe: valid signups 3 → 12`, with a table of every round. The person's working tree is never touched.

It usually takes 5 to 20 minutes, depending on how long the metric and the check take, and stops sooner when nothing wins. A round usually costs a few cents of model time (more on a big repo, because Synthe sends up to about 60,000 characters of code). The default limits are 6 rounds and $1.50 of model cost, whichever comes first.

### Rules

- Never guess the goal, the metric, the check or the mode. Ask the person.
- In the loop you do not write the code change. Synthe does. Do not edit code, tests, the metric command, `package.json`, lockfiles, `.github/` or `.synthe/` in this repo while it runs, and do not commit or switch branches. Synthe refuses its own changes to tests, the metric, its data, dependencies, config and CI.
- Never use `ANTHROPIC_API_KEY`. It is usually the app's own key, and Synthe ignores it here.
- Never write an event code, team code or key to a file, and never commit one.
- Do not interrupt a running `improve`: no Ctrl-C, no timeout shorter than 30 minutes, no second Synthe command in the same repo. If it was interrupted anyway, see step 5.
- Show the person Synthe's output as written: every number, and the reason when a change is not kept. Do not summarize it instead.
- If a command fails or stops, show the person the exact message and do what it says. Do not retry more than once without asking.

### Steps

1. **Credit.** Ask for the Crimson Hacks event code from the QR card and the team code from the Synthe table, or the person's own Anthropic key. Put them at the front of the command, because each command may run in a fresh shell (see section 2 for the same rules). Own key: `SYNTHE_ANTHROPIC_KEY=<key>` alone; tell the person it will show in this chat. If the person has neither codes nor a key, skip to "Without a credential" below.
2. **Commit and sync first.** `git status` must be clean: Synthe measures committed code. The current branch must be pushed and equal to its copy on GitHub; if not, push or `git pull`. Synthe opens its pull request against the branch you are on, or the default branch.
3. **See what this repo can measure:**

   ```
   npx synthe@latest improve --list
   ```

   Show the person the list as written. Then ask, in ONE message, these four things:
   - What should get better? One sentence.
   - Which metric from the list? Offer the first one in the list first: it is listed first because it fits the repo best. If they pick `custom`, also ask for the command that prints one number, what the number counts, and whether higher or lower is better.
   - Which regression check must keep passing? The list shows each metric's default; `none` is allowed.
   - Auto (the winning changes merge into the branch by themselves) or review (a pull request waits for them)? If they are unsure, say review.

   Do not run anything until they answer all four. Tell them: it usually takes 5 to 20 minutes and stops sooner when nothing wins, a round usually costs a few cents, and the default limit is $1.50.
4. **Run it**, with their answers and the credit at the front:

   ```
   SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx synthe@latest improve --agent --goal "<sentence>" --metric <id> --guard "<check command>" --mode auto|review
   ```

   - `<id>` is one of `test-pass`, `pytest`, `bundle-size`, `build-time`, `custom`.
   - For `--metric custom`, add `--command "<cmd>" --label "<what it counts>" --direction higher|lower`, and `--unit "<unit>"` if they gave one.
   - `--guard "<check command>"` is their check. Use `--guard none` for no check. Leave `--guard` out only to accept the metric's default shown in the list.
   - Add `--protect <path>` (repeat it) for any other file the changes must not touch. Add `--rounds N` (1 to 20) or `--budget <dollars>` only if the person asks for a different limit. Add `--lessons claude` or `--lessons agents` only if they want the lessons also written into `CLAUDE.md` or `AGENTS.md`; by default lessons go only to `.synthe/improve-lessons.md` and the pull request.
   - **Give the command a timeout of at least 30 minutes, and let it finish.** Many shell tools cap a command at about 10 minutes. If yours does, run the command in the background and wait for it to end, reading its output as it comes. Do not stop it.
   - While it runs, show the person each `Round` line as it appears, as written. You may leave out the `Measuring ...` and `Running the regression check ...` lines.
   - The output ends with a `NEXT:` line written for you. Do what it says; do not paste it to the person as if it were Synthe's result.
   - If it stops before the first round, it printed what to fix (a dirty tree, an unpushed branch, a missing credential, a regression check that fails today). Show it, fix that, and run the same command again.
5. **If it was interrupted** (Ctrl-C, a lost connection, a closed terminal), run the exact same command again. It starts over from the current code: nothing is pushed until the end of a run, so an interrupted run leaves nothing behind.
6. **Show the result as written**: the `Result:` line, the `Model cost` line and the `Pull request:` link. Then explain in plain words what happened: how many rounds ran, which changes were kept and why they helped, which were not kept and why, what it cost.
   - Review mode: tell the person to open the pull request, read the table of rounds, and merge it to keep the changes.
   - Auto mode: it prints `Merged into <branch>. Run git pull.` Tell the person to run `git pull`.
   - If it says `No change beat the current code`, nothing was pushed and no pull request exists. Show what was tried as written. Offer to run the same command again (the next run reads the lessons from this one) or to try `--handoff` below.
7. When the person asks what Synthe did, show the pull request's Result and Rounds sections word for word.

To undo: close the pull request before merging. After merging, `git revert` the merge or the commits, or ask the team to revert the pull request on GitHub.

### Without a credential: you make the change

Use this when the person has no event code, team code or key. Nothing is sent to a model. You make ONE small change to product code, and Synthe proves with numbers whether it improved the metric. Do steps 2 and 3 above first, then:

1. Measure the current code with their answers (`--handoff` takes the same options as step 4, except `--rounds`, `--budget` and `--lessons`):

   ```
   npx synthe@latest improve --handoff --agent --goal "<sentence>" --metric <id> --guard "<check command>" --mode auto|review
   ```

   It prints the baseline and a task card. If it stops instead, show the person the message and do what it says.
2. **Follow the `NEXT:` line.** Show the person the baseline and the task card. Create the branch the card names, make ONE small change to product code only, and commit it with a message that says what changed and why. Never edit tests, the metric command or its input files, `package.json`, lockfiles, `.github/`, `.synthe/` or config files; `submit` refuses those changes. If the improvement needs one, stop and tell the person why. Never loosen a test or the metric to make a number move.
3. Submit the change:

   ```
   npx synthe@latest submit --agent
   ```

   A win prints `Pull request: <url>`, and in auto mode `Merged into <branch>. Run git pull.` Show the person the result and the link as written.
4. If it prints `Not merged:` and a reason (within noise, worse, or the regression check failed), show it as written. If the person wants another try, make a different small change on the same branch, commit, and run `npx synthe@latest submit --agent` again (at most 3 attempts in all, unless they ask for more).
