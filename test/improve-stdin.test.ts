import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

// The real `ask` and `askSecret` in a child process with piped stdin: a person's answers, or a coding agent's,
// all in one write or arriving one by one. Bundled to a temp file, as improve-e2e.test.ts does, so it never races
// the dist/ rebuild in e2e.test.ts.
const work = mkdtempSync(join(tmpdir(), "synthe-stdin-"));
const bundle = join(work, "stdin-probe.mjs");

before(() => {
  const entry = join(work, "probe.ts");
  const here = join(process.cwd(), "src/cli");
  writeFileSync(entry, `import { askPiped, closeStdinLines } from ${JSON.stringify(join(here, "stdin-lines.ts"))};
import { askSecret } from ${JSON.stringify(join(here, "secret.ts"))};
// What ask() in src/cli/main.ts does for piped stdin.
const ask = askPiped;
const got: string[] = [];
for (const q of ["one? ", "two? ", "three? "]) got.push(await ask(q));
got.push(await askSecret("secret? "));
got.push(await ask("five? "));
got.push(await ask("six? "));
console.log("\\nGOT " + JSON.stringify(got));
closeStdinLines();
`);
  execSync(`npx esbuild ${JSON.stringify(entry)} --bundle --platform=node --format=esm --outfile=${JSON.stringify(bundle)}`, { stdio: "ignore" });
});

function probe(writes: [number, string][], end: boolean) {
  return new Promise<{ out: string; ms: number; code: number | null }>((resolve) => {
    const start = Date.now();
    const child = spawn("node", [bundle], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ out, ms: Date.now() - start, code }));
    for (const [at, text] of writes) setTimeout(() => child.stdin.write(text), at);
    // Leaving the pipe open must not keep the process alive once the questions are answered.
    if (end) setTimeout(() => child.stdin.end(), Math.max(...writes.map(([at]) => at)) + 50);
  });
}

const got = (out: string) => JSON.parse(out.split("GOT ")[1]);

test("every question reads the next line when all answers arrive in one write", async () => {
  const r = await probe([[0, "a\nb\nc\nd\ne\nf\n"]], false);
  assert.deepEqual(got(r.out), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(r.code, 0);
  assert.ok(r.ms < 5000, `process lingered ${r.ms}ms with stdin still open`);
});

test("every question reads the next line when answers arrive one at a time", async () => {
  const lines = ["a", "b", "c", "d", "e", "f"];
  const r = await probe(lines.map((l, i) => [i * 250, `${l}\n`] as [number, string]), false);
  assert.deepEqual(got(r.out), lines);
  assert.ok(r.out.includes("one? ") && r.out.includes("six? "));
});

test("input that ends early gives empty answers instead of hanging", async () => {
  const r = await probe([[0, "a\nb"]], true);
  assert.deepEqual(got(r.out), ["a", "b", "", "", "", ""]);
  assert.equal(r.code, 0);
});
