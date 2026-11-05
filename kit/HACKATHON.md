# Crimson Hacks kit

Friday, November 6. Nothing here has been used or sent yet.

Operators: see [no-spend readiness](OFFLINE-READINESS.md) before publishing or printing. The event flow is not yet in the published package, and the existing `v1.6.2` tag does not contain the pending event changes. Match the dollar amounts below to the final configured caps before distributing this kit.

## Intro slide

**Synthe: your agent gets better while you sleep.**

Run one command before you leave tonight. Synthe rewrites your agent's system prompt, tests each version, and merges only what wins. Completed rounds run back to back; 12 rounds usually finish in about half an hour. Open the report to see what changed.

```
npx synthe init
```

Event code on the QR card. Stop it any time.

Use this slide only after the overnight run works. Don't add results until we have real ones.

## QR card

Using Claude Code, Cursor or Codex? Tell it: Set up Synthe in this repo. Run `npx synthe@latest guide` and follow it.

**Synthe**
Your AI agent's prompt gets better while you build everything else.

1. Use the event code on this QR card ($4 run budget, on us; no Anthropic key needed).
2. In your repo, run `npx synthe@latest init`.
3. Say what your agent should get better at, confirm the checks Synthe proposes to measure it, and choose: merge improvements into main automatically, or review each one. During Crimson Hacks, Synthe shares your prompt, test cases and how the run goes with us (never your code); turn it off with "share": "none" in synthe.json.
4. After the run, open the report issue in your repo.

Needs the GitHub CLI, signed in. If main deploys your app, choose review. Stop any time: `npx synthe stop`

## Table script

- **What it changes:** only the system prompt, on your default branch.
- **What it costs you:** nothing with the event code. $4 of event credit per GitHub account (shared by all your repos); the proxy caps event spend.
- **What it won't do:** run your code or touch anything else.
- **How good is it?** It tests against simulated scenarios, so check the results yourself.
- **Prompt in code?** It handles most inline strings. If not, move the prompt into a file.

## Before merging overnight

Tell every team: automatic merges land on your default branch. If the repo deploys from it, each merge deploys. A team that doesn't want that can set `"merge_rule": { "mode": "propose" }` in `synthe.json`, and Synthe pauses for each winning pull request until they merge or close it. Repos that require reviews get this automatically.

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

Monday: we send Andrew a one-page readout with team counts, merges, check-in answers on trust and wins, and the numbers teams asked for.
