# Synthe

Synthe makes your AI agent's system prompt better while you sleep. It tries small changes to the prompt, tests them against the current one on simulated user messages, and keeps a change only when it's clearly better. Completed rounds start the next one immediately. It either merges the change into your main branch for you, or opens a pull request for you to review. You choose at setup.

```bash
npx synthe init
```

Using Claude Code, Cursor or Codex? Tell it: Set up Synthe in this repo. Run `npx synthe@latest guide` and follow it.

Setup reads your README and the code around your prompt, asks what your agent should get better at (and, optionally, a few real messages users send it), proposes checks that measure a good reply for you to confirm, shows you a few of your agent's real replies so you can fix any check that doesn't mean what you mean, asks whether to merge changes automatically or have you review them, and asks for your event code or own Anthropic key. When the run finishes, open the **Synthe: prompt report** issue in your repo. It says what changed, why, and how to undo it.

## Data

During Crimson Hacks, new installs use `"share": "full"` until November 8, 2026 at 23:59 UTC. This shares the prompt at the start of round 1, the full test-case file (train and holdout), the final prompt when the run stops, and how the run goes. After the cutoff, a full install automatically behaves like detail and stops sending the prompt and test-case file. New installs after the cutoff default to `"share": "detail"`.

Detail shares rounds, checks and spend, plus your goal, your checks, Synthe's prompt edits and one example message with its replies. Numbers go to the public `synthelabs/synthe-runs` repository; all text goes only to the private `synthelabs/synthe-feedback` repository. The Synthe team reads both. Synthe never sends your code, and removes keys, emails and phone numbers before sending. Detail never sends your whole prompt or test-case file.

To turn sharing off any time, set `"share": "none"` in `synthe.json`. Set `"share": "numbers"` to send numbers only, or run init with `DO_NOT_TRACK=1` to start with sharing off. Existing installs without a `share` setting stay off. To ask us to delete your team's data, open an issue on `synthelabs/synthe`.

## Before you start

- A GitHub repo you can admin, with your agent's system prompt in it, either in its own file or as a string in your code.
- The [GitHub CLI](https://cli.github.com), signed in (`gh auth login`), and Node 20 or later.
- A Crimson Hacks event code from the QR card, or your own Anthropic key. Event credit goes through Synthe's capped proxy; no Anthropic key is needed at the event.
- **Your main branch gets Synthe's changes if you choose automatic merging.** If main deploys your app, each change goes live. Choose review mode at setup if that's not what you want. Repos that require reviews get review mode automatically.

## What it adds to your repo

Setup commits three files: `synthe.json` (the goal, your rules and settings), `.synthe/scenarios.jsonl` (the test cases) and `.github/workflows/synthe.yml` (the workflow). It saves an event code as `SYNTHE_EVENT_CODE`, or your own key as `SYNTHE_ANTHROPIC_KEY`, in repo secrets. Your own key always wins over event credit. Event installs default to a $4 local run budget; own-key installs default to $3. A run budget is not a credit allowance: organizer-configured caps and shared event availability can stop an event run sooner. After that, the only file Synthe ever changes is your prompt. It never runs your agent's code.

Agent setup requires explicit `SYNTHE_ANTHROPIC_KEY` or `SYNTHE_EVENT_CODE` in both draft and confirmation; it never falls back to `ANTHROPIC_API_KEY`. Local event requests reuse a non-secret install ID at `$XDG_CONFIG_HOME/synthe/install-id`, or `~/.config/synthe/install-id` when no absolute config directory is set. The directory is private (0700), and the ID file is owner-only (0600), created atomically across CLI processes. It is not stored in your repo. This ID keeps the setup allowance stable on this installation, not across people, machines, deleted config directories or resets; it is not a server-side abuse boundary.

Set `SYNTHE_EVENT_CODE` in your environment to skip the code question. Local `try` and `calibrate` also accept it. To switch to your own key, run `npx synthe key` in your terminal, or explicitly supply `SYNTHE_ANTHROPIC_KEY` for noninteractive use. Using `ANTHROPIC_API_KEY` with `key` requires deliberately pressing Enter in your terminal; it is never a noninteractive fallback. Rounds then use your key instead of event credit. If credit stopped the run, run `npx synthe restart` afterward. Existing 1.6.x installs should run `npx synthe upgrade`, then commit and push the workflow to enable event credit.

## What happens each round

1. Synthe proposes 2 small changes to your prompt, aimed at the test cases where it does worst.
2. It runs your agent's current prompt and each change on the test cases. On each one, the reply that passes more of your checks wins; when they pass the same number, an AI judge compares the replies side by side.
3. A change is kept only if its replies are better in clearly more cases than they're worse (more than luck would explain), better again on test cases it never saw, and it breaks none of your rules where your old prompt followed them.
4. If a kept change later turns out worse than the prompt it replaced, Synthe puts the old one back.

It runs at most 12 rounds, usually finishing a full session in about half an hour. It stops sooner when 3 rounds in a row find nothing better, or when it has used its run budget. If Anthropic's API is busy, it tries again right away, up to twice. Event-credit refusals stop immediately without retries; the report shows what to do. Once you've fixed the cause, `npx synthe restart` continues it. (An hourly scheduled run is a backup, but GitHub often skips scheduled runs, so don't rely on it.) Review mode pauses until the team merges or closes Synthe's pull request.

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
| `npx synthe guide` | Instructions for setup through Claude Code, Cursor or Codex |
| `npx synthe key` | Save your own Anthropic key and stop using event credit |
| `npx synthe upgrade` | Update only the workflow for chained rounds; commit and push the changed workflow |
| `npx synthe status` | Show where it is |
| `npx synthe stop` | Stop it. Nothing more runs or changes |
| `npx synthe restart` | Start it again, after `stop` or once you've fixed what stopped it |
| `npx synthe try` | Run one round on your machine, changing nothing (event code or own key in the environment) |
| `npx synthe try --noise` | Compare your prompt with itself to see how much the judge varies |
| `npx synthe calibrate` | Check that your checks are marked the same way each time and the way you mean them, and reword any that aren't (event code or own key in the environment) |

## Change what it aims for

- `synthe.json`: `checks` (up to 5 plain sentences, each something a good reply does, such as "Asks for the order number before anything else"; these decide every test case), `brief` (what your agent is for), `objective` (what to get better at), `guardrails` (rules it must never break), `policy` (your business rules, which setup copies from your prompt so the judge knows what's allowed), `budget`, and `"merge_rule": { "mode": "propose" }` to review every change.
- `.synthe/scenarios.jsonl`: the test cases, one per line, such as `{"id": "s31", "input": "Can I return shoes I wore once?", "expected": "Explains worn items can't be returned and offers an exchange if they're faulty", "split": "train"}`. `split` is `train` (Synthe learns from it) or `holdout` (kept hidden to check its changes). After adding cases to a finished run, `npx synthe restart` starts it again.

## Removing it

Run `npx synthe stop`, then delete `synthe.json`, `.synthe/` and `.github/workflows/synthe.yml`, and the `SYNTHE_EVENT_CODE` and `SYNTHE_ANTHROPIC_KEY` secrets if present.
