# Crimson Hacks kit

Friday, November 6. Nothing here has been used or sent yet.

Operators should see [no-spend readiness](OFFLINE-READINESS.md) before publishing or printing. Use the GitHub release commands below for Crimson workflow tracking. The dollar amounts below match the configured caps as of November 5.

## Workshop (1 to 2 hours into the hackathon)

The Synthe session is a workshop 1 to 2 hours in, not at the start: by then teams have a repo and a first version of their agent, so Synthe has a prompt to improve.

**Before it starts (organizers)**

- Make team codes ahead of time with the organizer skill (`team.mjs create "<name>"`), one per expected team. Each team gets $4; the event pool is $80, so about 20 teams.
- Start the live organizer dashboard on Rishab's Mac and keep it open during the workshop.
- Print the QR cards (below).

**In the room, ask every team first**

1. Is your repo on GitHub, pushed, with your agent's prompt committed? If not, push it now.
2. Who owns the repo? That person runs setup. Setup saves repo secrets, which only a repo admin can do. Setup checks this and stops before it spends anything.
3. Are you on `main`, with `git pull` done?

**Run it (about 10 minutes)**

- In the repo, open the coding agent and paste the QR card's first line, or run the `init` command yourself. Give the team code at the table.
- Done means confirm printed `Added to main`, or opened an "Add Synthe" pull request. If it opened a pull request (a teammate pushed meanwhile), merge it now. Then the first round shows in the repo's Actions tab, and the "Synthe: prompt report" issue appears.
- If the agent stopped after the draft ("Synthe is NOT installed yet"), run the confirm step. A team that drafted but never confirmed shows on the dashboard with setup activity and no linked repo: go to its table.

**After**

- A run is up to 12 rounds and up to about 30 minutes; it stops sooner, often within 5 to 10 minutes, when nothing beats the team's prompt. Teams keep building meanwhile. In auto mode Synthe commits to the prompt file on `main`, so everyone runs `git pull` before editing the prompt or pushing.
- Ask "what did Synthe do?" in the coding agent at any time; it runs `npx synthe changes`.
- Known limits: many teams starting at once can hit model rate limits. The proxy retries twice, then the round fails and counts toward a stop. A run that stops because nothing was clearly better restarts only after new test cases are added.

## Workshop slide

**Synthe: your agent's prompt gets better while you keep building.**

Set it up now, in about 10 minutes. Synthe rewrites your agent's system prompt, tests each version, and merges only what wins. A run takes up to about half an hour. Open the report to see what changed.

```
npx --yes github:synthelabs/synthe#v1.8.6 init
```

Event code on the QR card. The repo's owner runs it. Stop it any time.

Don't add results to this slide until we have real ones.

## QR card

Using Claude Code, Cursor or Codex? Tell it to set up Synthe in this repo and follow the instructions from `npx --yes github:synthelabs/synthe#v1.8.6 guide`.

No AI prompt in your app yet? Tell your coding agent: Set up Synthe improve mode in this repo. Run `npx synthe@latest guide` and follow section 9. It measures one number before and after a code change and opens the pull request. No event code needed.

No coding agent, or a free web chat? Do the steps below in your terminal. A web chat can't see your repo or run commands, and setup asks its own questions, so you don't need an AI tool for it.

**Synthe**
Your AI agent's prompt gets better while you build everything else.

1. Push your repo with your agent's prompt committed. The repo's owner runs setup, on `main`, after `git pull`. Have the event code from the QR card and the team code from the Synthe table ready. The $4 run budget can use event credit.
2. In your repo, run `npx --yes github:synthelabs/synthe#v1.8.6 init`.
3. Say what your agent should get better at, confirm the checks Synthe proposes, and choose whether to merge improvements automatically or review each one. Crimson requires workflow tracking even with your own Anthropic key. By default, Synthe also shares research data about your run, including your prompt and test cases through November 9 at 23:59 UTC.
4. After the run, open the report issue in your repo.

Needs the GitHub CLI, signed in. If main deploys your app, choose review. Stop any time: `npx synthe stop`

If Synthe is already installed, run `npx --yes github:synthelabs/synthe#v1.8.6 upgrade --event` and commit both generated workflow files to your default branch. Confirm both event and team secrets are set before the next run.

## Table script

- **What it changes:** only the system prompt, on your default branch.
- **What it costs you:** nothing with the event code. Each install runs on a $4 budget, and the Synthe proxy caps total event spend.
- **What it won't do:** run your code or touch anything else.
- **How good is it?** It tests against simulated scenarios, so check the results yourself.
- **Prompt in code?** It handles most inline strings. If not, move the prompt into a file.

## Before merging automatically

Tell every team: automatic merges land on your default branch while you keep building, so run `git pull` before you edit the prompt or push. If the repo deploys from it, each merge deploys. A team that doesn't want that can set `"merge_rule": { "mode": "propose" }` in `synthe.json`, and Synthe pauses for each winning pull request until they merge or close it. Repos that require reviews get this automatically.

## Event credit, Thursday November 5

Teams receive event codes, not Anthropic keys. The proxy holds one key and caps spend.

- [ ] Add credit and configure the proxy's event spend cap
- [ ] Test an event code locally and in GitHub Actions with OIDC
- [ ] Print the event code on the QR cards
- [ ] Test the credit refusal and own-key switch before teams arrive
- [ ] After the event, disable the event codes

## Traction to record

- Teams that picked up an event code
- Repos with at least one merge by Saturday morning
- Average score change and real cost per team
- Failures and their causes
- npm downloads

## Tester script, Wednesday November 4

Give each tester the QR card only, with no other help. Record the time to the first round and where they got stuck.

Ask afterward, one at a time:
1. What did you expect `npx synthe init` to do?
2. Which step made you stop or ask for help?
3. Read the checks Synthe proposed. Which ones match how you would judge your agent?
4. Which check is missing, or wrong?
5. You chose merge or review. Why that one?
6. Would you let it merge to your default branch while nobody is watching? What would change your answer?

## Saturday morning check-in

Ask each team at the table. It should take 3 minutes. Write down their words.

1. Did Synthe merge anything, or did you merge any of its pull requests? If not, why?
2. Open one change. Is the new prompt better, worse, or the same for your agent?
3. Does "checks passed X%, up from Y%" match what you see when you use your agent?
4. If Synthe could read one real number about your agent, which would you pick?
5. Where did setup slow you down?

## What we record per team

| Field | Where it comes from |
|---|---|
| Event workflow start, attempt, finish and outcome | Required Crimson tracking receipts |
| Sharing choice (nothing, numbers, detail, or Crimson Hacks full) | The `share` setting in synthe.json |
| Rounds run, merges, checks passed (start and end) | Shared numbers in synthelabs/synthe-runs |
| Goal, checks, edits, one example message and its replies | Private synthelabs/synthe-feedback, for detail and full sharing |
| Prompt at start, train and holdout test cases, final prompt | Private synthelabs/synthe-feedback, for full sharing before November 9 at 23:59 UTC |
| Real cost | Key spend in the Console, plus shared numbers |
| Time to first round, where they got stuck | Our table notes |
| Merge mode chosen and whether they merged PRs | Check-in answer 1, plus our table notes |
| Checks that matched or missed their judgement | Tester script answers 3 and 4, check-in answer 3 |
| Did the wins hold up | Check-in answer 2 |
| The real number they'd want improved | Check-in answer 4 |

Monday: we send the sponsor a one-page readout with team counts, merges, check-in answers on trust and wins, and the numbers teams asked for.
