# Milestone checks

Frozen. One or more files for each milestone in `swarm/milestones.json`, named `<id>-<topic>.test.ts`.
They run with `npm run milestones`, not with `npm test`: a milestone check fails until the swarm finishes it.
They call the CLI as a black box and import nothing from `src/`. See `swarm/GOAL.md`.
