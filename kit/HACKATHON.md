# Crimson Hacks kit

Friday, November 6. Nothing here has been used or sent yet.

## Intro slide

**Synthe: your agent gets better while you sleep.**

Run one command before you leave tonight. Synthe rewrites your agent's system prompt, tests each version, and merges only what wins. Wake up to a better agent and a report of what changed.

```
npx synthe init
```

Free keys at the Synthe table. Stop it any time.

Use this slide only after the overnight run works. Don't add results until we have real ones.

## QR card

**Synthe**
Your AI agent's prompt gets better while you sleep.

1. Grab a key from the Synthe table ($3 of credit, on us).
2. In your repo, run `npx synthe init`.
3. Say what your agent should get better at, and choose: merge improvements into main automatically, or review each one.
4. In the morning, open the report issue in your repo.

Needs the GitHub CLI, signed in. If main deploys your app, choose review. Stop any time: `npx synthe stop`

## Table script

- **What it changes:** only the system prompt, on your default branch.
- **What it costs you:** nothing. Your key is capped at $3.
- **What it won't do:** run your code or touch anything else.
- **How good is it?** It tests against simulated scenarios, so check the results yourself.
- **Prompt in code?** It handles most inline strings. If not, move the prompt into a file.

## Before merging overnight

Tell every team: automatic merges land on your default branch. If the repo deploys from it, each merge deploys. A team that doesn't want that can set `"merge_rule": { "mode": "propose" }` in `synthe.json`, and Synthe leaves each winning pull request for them to merge in the morning. Repos that require reviews get this automatically.

## Capped keys, Thursday November 5

Allow 30 to 45 minutes. It's manual, because the Spend Limits API isn't open to Console accounts.

- [ ] Add credit: teams x $3, plus a margin
- [ ] For each team, create a workspace named `crimson-01`, `crimson-02` and so on
- [ ] Set that workspace's spend limit to $3
- [ ] Create one key in it
- [ ] Print each key on its own slip
- [ ] Keep the list private, and make 5 spares
- [ ] After the event, delete every key

## Traction to record

- Teams that picked up a key
- Repos with at least one merge by Saturday morning
- Average score change and real cost per team
- Failures and their causes
- npm downloads

## Tester script, Wednesday November 4

Give each tester the QR card and no other help. Record the time to the first run and where they got stuck.

Ask afterward:
1. What did you expect it to do?
2. Would you trust it on your default branch?
3. What almost made you give up?
