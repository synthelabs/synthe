# How the swarm works

Read `swarm/GOAL.md` first. It gives the goal, the milestones and the contract that the checks use.

## Roles

- **The lead**: one agent. It splits the work, makes crews, picks a captain for each crew, and moves helpers to
  where the work is. It gives orders in the ledger's `announce` table and assignments in the `assign` table.
- **Captains**: one helper in each crew. A captain posts a plan for its milestone (a note with `--kind plan`) and
  splits the work into tasks.
- **Helpers**: claim a task, do it, merge it, mark it done. Any helper can add tasks. If a task is too big for one
  pull request, split it into child tasks with `--parent`.
- **The coordinator**: a person's agent outside the swarm. It owns the frozen checks, fixes check bugs, watches the
  merges, and promotes `integration` to `main`.
- **The monitor**: reads every merged pull request. It looks for work that games a check instead of meeting it.

## Start

1. Clone the repository and check out `integration`.
2. Run `node scripts/swarm/ledger.mjs whoami <your id>` once. Your id is in your first message.
3. Run `npm ci`.
4. Run `node scripts/swarm/ledger.mjs status`.

## The helper loop

1. Run `node scripts/swarm/ledger.mjs status`. Read the latest orders and your assignment.
2. If you have no assignment, run `node scripts/swarm/ledger.mjs wait`. Then read the status again.
3. Read your milestone's plan in the notes. Run `ready --milestone <id>` and claim one task with `claim <task>`.
4. If `claim` says another agent holds the task, claim a different one.
5. Make a branch from the latest `integration`: `swarm/<your id>/<task>`.
6. Do the work. Run `npm run typecheck`, `npm test` and `npm run milestones -- <id>`.
7. Restore `dist/` with `git checkout -- dist`. Never commit `dist/`: the merge job rebuilds it.
8. Push the branch. Open a pull request into `integration`. The merge job checks it and merges it.
9. If the merge job refuses it, read the job log, fix the cause, and push again.
10. When it merges, run `done <task> --pr <url>` and `land "<summary>" --milestone <id> --pr <url>`.
11. Post a short note on what changed and what is next. Go to step 1.

If you finish and have no task, post a note with `--kind free` and say what you can take. Then wait.
Do not wait for the lead if the orders say so: claim any ready task.

## Rules

- **Done means the check passes on `integration`.** A note, a claim or a green pull request does not make a
  milestone done.
- **Never change a frozen path.** The list is in `swarm/GOAL.md`. A hook and the merge job refuse it.
- **Never game a check.** Do not detect the test, special-case the zoo, or hard-code expected numbers. The monitor
  reads every merge. Gamed work is reverted and the task goes back to the queue.
- **If a check looks wrong, say so.** Post a note with `--kind check-bug` that names the test and the reason. Then
  work on something else.
- **"Blocked" and "infeasible" do not close a task.** Post a note with `--kind blocked` and the reason. Release the
  task. The lead reopens it later. Teams often judge work as harder than it is.
- **Keep pull requests small.** One task in each pull request. Merge `integration` into your branch if it conflicts.
  Never rebase a pushed branch and never force-push.
- **Spend nothing.** Swarm sessions have no paid model keys. Never call a real model API.
- **AGENTS.md applies**, except for two rules that this file replaces for swarm work: pull requests go into
  `integration`, and the merge job merges them, not a maintainer.

## The ledger

The ledger is the `ledger` branch. `scripts/swarm/ledger.mjs` reads and writes it. Run it with no command for the
usage. Every write is a commit that is pushed at once, so every agent sees the same state.

| Table | Who writes | What |
|---|---|---|
| `announce` | the lead | orders to the whole team |
| `assign` | the lead | who works on which milestone, and the captains |
| `notes` | everyone | plans, progress, verdicts, check bugs, blocks, free helpers |
| `tasks` | everyone | the to-do list |
| `claims` | everyone | the first claim on a task wins |
| `done` | everyone | finished tasks |
| `landed` | everyone | work that merged into `integration` |
