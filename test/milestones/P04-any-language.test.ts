// P04: `solve` improves a Python project and a plain shell-script project that have no package.json, with measure
// and guard commands in those languages.
// How it decides: each project is a temp git repo with no package.json. A scripted proposer offers, in this order, a
// change that raises the score but fails the guard, a change that lowers the score, and the real fix (the shell
// project has two fixes that build on each other). The check passes when result.json gives the exact baseline and
// final scores that the language's own measure prints, only the real fixes are kept, and the branch holds them.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approx, fileOnBranch, keptAttempts, makeRepo, problemFile, rng, solve, word, workDir, write, writeMenuProposer, type Proposal } from "./helpers-b.ts";

test("solve improves a Python project with a Python measure and a Python guard", async () => {
  const r = rng(`P04-python-${process.pid}-${Date.now()}`);
  const fn = `count_${word(r)}_words`;
  const work = workDir("p04-py");
  // Cases with extra spaces, tabs and empty text: text.split(" ") gets them wrong, text.split() gets them right.
  const cases: [string, number][] = [["one two", 2], ["a  b  c", 3], [" lead", 1], ["trail ", 1], ["tab\tsep", 2], ["", 0], ["x", 1], ["p q r s", 4], ["  ", 0], ["m\t n", 2]];
  const splitSpace = (t: string) => t.split(" ").length;
  const before = cases.filter(([t, n]) => splitSpace(t) === n).length;
  const pct = (k: number) => Math.round((1000 * k) / cases.length) / 10;
  const repo = makeRepo(join(work, "repo"), {
    "textkit/__init__.py": "",
    "textkit/words.py": `def ${fn}(text):\n    # Counts the words in one line of text.\n    return len(text.split(" "))\n\n\ndef count_lines(text):\n    return len(text.splitlines())\n`,
    "measure/score.py": `import os, sys\nsys.path.insert(0, os.getcwd())\nfrom textkit.words import ${fn}\nCASES = ${JSON.stringify(cases)}\nok = sum(1 for t, n in CASES if ${fn}(t) == n)\nprint("checked %d cases" % len(CASES))\nprint("score %.1f" % round(100.0 * ok / len(CASES), 1))\n`,
    "tests/test_words.py": `import os, sys, unittest\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\nfrom textkit.words import ${fn}, count_lines\n\nclass Words(unittest.TestCase):\n    def test_plain(self):\n        self.assertEqual(${fn}("one two three"), 3)\n    def test_lines(self):\n        self.assertEqual(count_lines("a\\nb"), 2)\n\nunittest.main()\n`,
  });
  const menu: Proposal[] = [
    { summary: `keep only ${fn} in the module`, edits: [{ path: "textkit/words.py", search: `    return len(text.split(" "))\n\n\ndef count_lines(text):\n    return len(text.splitlines())\n`, replace: "    return len(text.split())\n" }] },
    { summary: "do not count the last word", edits: [{ path: "textkit/words.py", search: `return len(text.split(" "))`, replace: `return len(text.split(" ")) - 1` }] },
    { summary: "split on any run of whitespace", edits: [{ path: "textkit/words.py", search: `return len(text.split(" "))`, replace: "return len(text.split())" }] },
  ];
  write(work, "menu.json", JSON.stringify(menu));
  const proposer = writeMenuProposer(join(work, "propose.mjs"), join(work, "menu.json"), join(work, "proposer.log"), true);
  const file = problemFile(repo.dir, "problem.json", {
    name: `py-${word(r)}`, goal: "Count words correctly in every line of text.",
    artifact: ["textkit/**/*.py"], protect: ["measure/**", "tests/**"],
    measure: { command: "python3 measure/score.py", direction: "higher", unit: "points", runs: 2 },
    guards: ["python3 tests/test_words.py"],
    proposer: { command: `node ${JSON.stringify(proposer)}` },
    budget: { max_rounds: 6 },
  });
  repo.git("add", "problem.json");
  repo.git("commit", "-qm", "Problem file");
  assert.equal(existsSync(join(repo.dir, "package.json")), false);

  const { result } = await solve(file, join(work, "out"));
  approx(result.baseline, pct(before), "result.json baseline (the Python measure's last number)");
  approx(result.final, 100, "result.json final");
  assert.deepEqual(keptAttempts(result).map((a) => a.summary), [menu[2].summary], "only the real fix is kept");
  for (const bad of menu.slice(0, 2)) {
    const a = result.attempts.find((x) => x.summary === bad.summary);
    assert.ok(a, `the attempt "${bad.summary}" is in result.json`);
    assert.equal(a.kept, false, `"${bad.summary}" is refused`);
  }
  const kept = fileOnBranch(repo, result, "textkit/words.py");
  assert.match(kept, /return len\(text\.split\(\)\)/);
  assert.match(kept, /def count_lines/, "the change that failed the Python guard is not on the branch");
});

test("solve improves a plain shell-script project with a shell measure and a shell guard", async () => {
  const r = rng(`P04-shell-${process.pid}-${Date.now()}`);
  const work = workDir("p04-sh");
  const titles: [string, string][] = [["Hello World", "hello-world"], ["Shell Scripts Rock", "shell-scripts-rock"], ["plain", "plain"], ["Two  Spaces", "two-spaces"], [`${word(r)} Notes`, ""], ["a b", "a-b"], ["Big   Gap Here", "big-gap-here"], ["UPPER", "upper"]];
  for (const t of titles) if (!t[1]) t[1] = t[0].toLowerCase().replace(/ +/g, "-");
  const slug0 = (t: string) => t.replace(/ /g, "-");
  const slug1 = (t: string) => t.toLowerCase().replace(/ /g, "-");
  const count = (f: (t: string) => string) => titles.filter(([t, s]) => f(t) === s).length;
  const scale = 5 + Math.floor(r() * 20);
  const q = (s: string) => `'${s}'`;
  const repo = makeRepo(join(work, "repo"), {
    "bin/slug.sh": "#!/bin/sh\n# Turns a title into a URL slug.\nprintf '%s\\n' \"$1\" | tr ' ' '-'\n",
    "measure/score.sh": `#!/bin/sh\npass=0\ntotal=0\ncheck() {\n  total=$((total + 1))\n  out=$(sh bin/slug.sh "$1")\n  if [ "$out" = "$2" ]; then pass=$((pass + 1)); fi\n}\n${titles.map(([t, s]) => `check ${q(t)} ${q(s)}`).join("\n")}\necho "passed $pass of $total"\necho "score: $((pass * ${scale}))"\n`,
    "tests/run.sh": "#!/bin/sh\n[ \"$(sh bin/slug.sh 'a b')\" = 'a-b' ] || { echo 'a b must give a-b'; exit 1; }\n[ \"$(sh bin/slug.sh 'zz')\" = 'zz' ] || { echo 'zz must give zz'; exit 1; }\necho ok\n",
  });
  const lookup = `case "$1" in\n${titles.map(([t, s]) => `  ${q(t)}) echo ${q(s)} ;;\n`).join("")}esac\n`;
  const menu: Proposal[] = [
    { summary: "answer the known titles directly", edits: [{ path: "bin/slug.sh", search: "printf '%s\\n' \"$1\" | tr ' ' '-'\n", replace: lookup }] },
    { summary: "use underscores between words", edits: [{ path: "bin/slug.sh", search: "tr ' ' '-'", replace: "tr ' ' '_'" }] },
    { summary: "make the slug lower case", edits: [{ path: "bin/slug.sh", search: "tr ' ' '-'", replace: "tr 'A-Z ' 'a-z-'" }] },
    { summary: "join runs of dashes into one", edits: [{ path: "bin/slug.sh", search: "tr 'A-Z ' 'a-z-'", replace: "tr 'A-Z ' 'a-z-' | sed 's/--*/-/g'" }] },
  ];
  write(work, "menu.json", JSON.stringify(menu));
  const proposer = writeMenuProposer(join(work, "propose.mjs"), join(work, "menu.json"), join(work, "proposer.log"), true);
  const file = problemFile(repo.dir, "problem.json", {
    name: `sh-${word(r)}`, goal: "Turn every title into the right URL slug.",
    artifact: ["bin/*.sh"], protect: ["measure/**", "tests/**"],
    measure: { command: "sh measure/score.sh", direction: "higher", unit: "points", runs: 2 },
    guards: ["sh tests/run.sh"],
    proposer: { command: `node ${JSON.stringify(proposer)}` },
    budget: { max_rounds: 8 },
  });
  repo.git("add", "problem.json");
  repo.git("commit", "-qm", "Problem file");
  assert.equal(existsSync(join(repo.dir, "package.json")), false);

  const { result } = await solve(file, join(work, "out"));
  assert.ok(count(slug0) < count(slug1) && count(slug1) < titles.length, "the fixture has two real steps");
  approx(result.baseline, count(slug0) * scale, "result.json baseline (the shell measure's last number)");
  approx(result.final, titles.length * scale, "result.json final");
  assert.deepEqual(keptAttempts(result).map((a) => a.summary).sort(), [menu[2].summary, menu[3].summary].sort(), "only the two real fixes are kept");
  for (const bad of menu.slice(0, 2)) {
    const a = result.attempts.find((x) => x.summary === bad.summary);
    assert.ok(a, `the attempt "${bad.summary}" is in result.json`);
    assert.equal(a.kept, false, `"${bad.summary}" is refused`);
  }
  const kept = fileOnBranch(repo, result, "bin/slug.sh");
  assert.ok(kept.includes("tr 'A-Z ' 'a-z-' | sed 's/--*/-/g'"), `the branch holds both fixes. Got:\n${kept}`);
  assert.ok(!kept.includes("case "), "the change that failed the shell guard is not on the branch");
});
