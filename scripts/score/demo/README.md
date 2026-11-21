# The demo set

Two toy problems in the layout of the hidden set. They are public. `node scripts/score/score.mjs --self-test` runs
the scorer on them against a loopback fake model, so it needs no key and spends nothing.

Each problem is a folder:

- `meta.json`: the kind of work, and whether the measure is exact.
- `repo/`: the files that go into a temporary git repository, with `problem.json` at the root.
- `reference/`: the files of a reference solution. The scorer puts them on top of `repo/` to measure the reference.
- `scorer/` (optional): files only the scorer reads. `meta.json` can name a `holdout_command` that uses them.

`fake-replies.json` is the menu of the fake model: for each problem, a marker text and the proposals it makes.
