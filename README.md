# Synthe

Your agent improves its own system prompt overnight and merges the wins.

```bash
npx synthe init
```

Answer one question, paste your key, and go to sleep. In the morning, open the **Synthe: overnight prompt report** issue in your repo to see what merged and why.

## What it does

Every hour, up to 12 times, Synthe:

1. Writes 2 new versions of your system prompt, studying the replies that lost last round.
2. Puts each one head to head with your current prompt on simulated scenarios, including 10 the writer never sees.
3. Merges the winner only if it wins scenario by scenario, gains on the 10 unseen scenarios and breaks no guardrail.
4. Reverts a merged prompt if the prompt it replaced later beats it clearly, head to head.

It only ever changes the system prompt. It never touches your other code, your CI or your secrets, and it never runs your agent's code.

## What it doesn't do

Scores come from simulated scenarios, not real users, so a higher score doesn't guarantee better results in production. Tools your agent calls aren't exercised.

## Stop it

```bash
npx synthe stop
```

It also stops by itself when the budget ($3 by default) runs out, after 3 rounds with no winner, or after 12 rounds.

## Commands

| Command | What it does |
| --- | --- |
| `npx synthe init` | Set up this repo and start |
| `npx synthe status` | Show progress |
| `npx synthe stop` | Stop all runs |
| `npx synthe try` | Run one round locally, changing nothing |
| `npx synthe try --noise` | Judge your prompt against itself to see how noisy judging is |

## Requirements

A GitHub repo you admin and the [GitHub CLI](https://cli.github.com), signed in. If your default branch requires reviews, exempt Actions in your branch rules or Synthe will stop and tell you.

## Change the goal

Edit `synthe.json` for the objective, guardrails and budget, and `.synthe/scenarios.jsonl` for the test cases. Scenario rows marked `holdout` stay hidden from the writer.
