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

- **No AI prompt, or the person wants a code change measured by a number** (tests passing, bundle size, build time, or a command of theirs): use **improve mode**. Go to section 9 and skip sections 1 to 8. It needs no event code and no key.
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
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.6 init --agent ...
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
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.6 init --agent --prompt <path> --objective "<sentence>" --mode auto|review --message "<msg>" --message "<msg>"
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
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.6 init --agent --confirm --check "<final sentence>" --check "<final sentence>"
```

If the person accepted every proposed check as it is, run this instead:

```
SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx --yes github:synthelabs/synthe#v1.8.6 init --agent --confirm --keep-checks
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

You make one small code change and prove, with numbers, that it improved the metric the person chose. Synthe's rules below are what make the result trustworthy: the same command measured the same way before and after, in clean checkouts, with the tests and the metric left exactly as they were.

### Rules

- Never guess the goal, the metric or the mode. Ask the person.
- Never edit tests, the metric command or its input files, `package.json`, lockfiles, `.github/`, `.synthe/` or config files. If the change needs one of those, stop and tell the person why; do not make it.
- One small change per attempt. Never loosen a test or the metric to make a number move.
- Show the person every number as measured. A change that is not clearly better is reported as not better, never rounded up.

### Steps

1. **Check the repo.** `git status` must be clean (commit first: only committed code is measured). `gh auth status` must succeed, and `gh repo view` must show the repo on GitHub. Note the default branch.
2. **Ask the person, in one message:**
   - What should get better? One sentence.
   - Which number measures it? Offer what the repo can run: `npm test` (number of passing tests, higher is better) if there is a test script; `npm run build` then total gzipped bytes of the built JS and CSS (lower is better) if there is a build script; build time in seconds (lower); or a command of theirs that prints one number, with higher or lower.
   - Which regression check? Default `npm test` when it exists. It must pass before and after.
   - Auto (a winning change merges into the default branch by itself) or review (a pull request waits for them)?
3. **Measure the current code.** In a clean copy, so uncommitted files cannot leak in:

   ```
   git worktree add --detach /tmp/synthe-base HEAD
   ```

   In that folder, link `node_modules` from the repo if the project needs it (`ln -s <repo>/node_modules node_modules`). Run the metric command 3 times and write down all three values and the median. Run the regression check once; it must pass. If the metric prints nothing usable or the check fails, stop and show the person the exact output. Then `git worktree remove --force /tmp/synthe-base`.
4. **Show the baseline** to the person: the three values, the median, the direction, and the check result.
5. **Make the change.** `git checkout -b synthe/improve-1`. Change product code only. Commit with a message that says what changed and why.
6. **Measure the change the same way:** a fresh worktree of the new commit (`git worktree add --detach /tmp/synthe-candidate HEAD`), the same metric command 3 times, the same regression check once, then remove the worktree.
7. **Decide.** The change wins only if all three hold: the median moved in the right direction; it moved by more than the spread of the runs (the larger of the two max-minus-min ranges); the regression check passed. Otherwise it did not win. Say so with the numbers, and either try one different small change (at most 3 attempts in all) or stop.
8. **Publish a win.** `git push -u origin synthe/improve-1`, then open the pull request:

   ```
   gh pr create --base <default branch> --title "Synthe: <metric> <before> → <after>" --body-file <file>
   ```

   The body has four headings: **Result** (before, after, the three runs each, the spread, the regression check and its command), **What changed** (`git diff --stat` and one sentence), **How it was measured** (the metric command, "each measured in a fresh checkout of its commit", both commit SHAs), **Undo** ("close this pull request", or in auto mode `git revert <merge commit>`). End with: "Measured by Synthe on this machine; check the numbers in your own environment too."
   In auto mode, then run `gh pr merge --squash --delete-branch` and tell the person to `git pull`. If GitHub refuses the merge, say the pull request is open for a person to merge.
9. **Show the person** the pull request link and the before and after numbers as written. When they ask what Synthe did, show the pull request's Result section word for word.
