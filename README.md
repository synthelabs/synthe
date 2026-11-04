# Synthe

Synthe makes your AI agent's system prompt better while you sleep. It tries small changes to the prompt, tests them against the current one on simulated user messages, and keeps a change only when it's clearly better. Completed rounds start the next one immediately. It either merges the change into your main branch for you, or opens a pull request for you to review. You choose at setup.

```bash
npx synthe init
```

Setup reads your README and the code around your prompt, asks what your agent should get better at (and, optionally, a few real messages users send it), proposes checks that measure a good reply for you to confirm, shows you a few of your agent's real replies so you can fix any check that doesn't mean what you mean, asks whether to merge changes automatically or have you review them, and asks for your Synthe key. When the run finishes, open the **Synthe: prompt report** issue in your repo. It says what changed, why, and how to undo it.

## Data

During Crimson Hacks, new installs use `"share": "full"` until November 8, 2026 at 23:59 UTC. This shares the prompt at the start of round 1, the full test-case file (train and holdout), the final prompt when the run stops, and how the run goes. After the cutoff, a full install automatically behaves like detail and stops sending the prompt and test-case file. New installs after the cutoff default to `"share": "detail"`.

Detail shares rounds, checks and spend, plus your goal, your checks, Synthe's prompt edits and one example message with its replies. Numbers go to the public `synthelabs/synthe-runs` repository; all text goes only to the private `synthelabs/synthe-feedback` repository. The Synthe team reads both. Synthe never sends your code, and removes keys, emails and phone numbers before sending. Detail never sends your whole prompt or test-case file.

To turn sharing off any time, set `"share": "none"` in `synthe.json`. Set `"share": "numbers"` to send numbers only, or run init with `DO_NOT_TRACK=1` to start with sharing off. Existing installs without a `share` setting stay off. To ask us to delete your team's data, open an issue on `synthelabs/synthe`.

## Before you start

- A GitHub repo you can admin, with your agent's system prompt in it, either in its own file or as a string in your code.
- The [GitHub CLI](https://cli.github.com), signed in (`gh auth login`), and Node 20 or later.
- A Synthe key. At Crimson Hacks, get one at the Synthe table. It has $3 of credit, paid by Synthe.
- **Your main branch gets Synthe's changes if you choose automatic merging.** If main deploys your app, each change goes live. Choose review mode at setup if that's not what you want. Repos that require reviews get review mode automatically.

## What it adds to your repo

Setup commits three files: `synthe.json` (the goal, your rules and settings), `.synthe/scenarios.jsonl` (the test cases) and `.github/workflows/synthe.yml` (the workflow). It saves your key as the repo secret `SYNTHE_ANTHROPIC_KEY`. After that, the only file Synthe ever changes is your prompt. It never runs your agent's code.

## What happens each round

1. Synthe proposes 2 small changes to your prompt, aimed at the test cases where it does worst.
2. It runs your agent's current prompt and each change on the test cases. On each one, the reply that passes more of your checks wins; when they pass the same number, an AI judge compares the replies side by side.
3. A change is kept only if its replies are better in clearly more cases than they're worse (more than luck would explain), better again on test cases it never saw, and it breaks none of your rules where your old prompt followed them.
4. If a kept change later turns out worse than the prompt it replaced, Synthe puts the old one back.

It runs at most 12 rounds, usually finishing a full session in about half an hour. It stops sooner when 3 rounds in a row find nothing better, or when it has used its $3. If Anthropic's API is busy, it tries again right away, up to twice. If a session stops early for any other reason, `npx synthe restart` continues it. (An hourly scheduled run is a backup, but GitHub often skips scheduled runs, so don't rely on it.) Review mode pauses until the team merges or closes Synthe's pull request.

## While it runs

- You can keep editing your prompt. Synthe always starts from the latest version on main. After it changes the prompt, pull before you edit it.
- To keep your agent unchanged, for example before a demo, run `npx synthe stop`.
- `npx synthe status` shows where it is.

## What it doesn't test

The test cases are simulated single messages, not real users or full conversations, and your agent's tools aren't run. A better result here is a strong hint, not proof of how real users will react.

## Commands

| Command | What it does |
| --- | --- |
| `npx synthe init` | Set up this repo and start |
| `npx synthe upgrade` | Update only the workflow for chained rounds; commit and push the changed workflow |
| `npx synthe status` | Show where it is |
| `npx synthe stop` | Stop it. Nothing more runs or changes |
| `npx synthe restart` | Start it again, after `stop` or once you've fixed what stopped it |
| `npx synthe try` | Run one round on your machine, changing nothing (needs `ANTHROPIC_API_KEY`) |
| `npx synthe try --noise` | Compare your prompt with itself to see how much the judge varies |
| `npx synthe calibrate` | Check that your checks are marked the same way each time and the way you mean them, and reword any that aren't (needs `ANTHROPIC_API_KEY`) |

## Change what it aims for

- `synthe.json`: `checks` (up to 5 plain sentences, each something a good reply does, such as "Asks for the order number before anything else"; these decide every test case), `counter_checks` (optional guards, up to 5 sentences, usually one per check, each catching a way to pass a check without really helping, such as "Still answers the question fully" for "Stays under three sentences"; a change that passes the guards clearly less often isn't merged, `merge_rule.guard_margin` sets how many points less is allowed, 3 by default. Guards are marked by the same kind of AI as checks. They reduce gaming but do not remove it.), `brief` (what your agent is for), `objective` (what to get better at), `guardrails` (rules it must never break), `policy` (your business rules, which setup copies from your prompt so the judge knows what's allowed), `budget`, and `"merge_rule": { "mode": "propose" }` to review every change.
- `.synthe/scenarios.jsonl`: the test cases, one per line, such as `{"id": "s31", "input": "Can I return shoes I wore once?", "expected": "Explains worn items can't be returned and offers an exchange if they're faulty", "split": "train"}`. `split` is `train` (Synthe learns from it) or `holdout` (kept hidden to check its changes). After adding cases to a finished run, `npx synthe restart` starts it again.

## Removing it

Run `npx synthe stop`, then delete `synthe.json`, `.synthe/` and `.github/workflows/synthe.yml`, and the `SYNTHE_ANTHROPIC_KEY` secret.
