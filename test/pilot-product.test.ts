// The pilot as a product command: `npx synthe pilot <command>`. These tests run the product bundle, built the way
// `npm run build` builds it, because that file is what a team gets from npx.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmp } from "./pilot-cli-helpers.ts";

const ROOT = join(import.meta.dirname, "..");
// Nothing from the developer's shell reaches the commands: no token, no key, no Synthe setting.
const env = { PATH: process.env.PATH ?? "" };

// The first command of the package's own build script, pointed at a temporary file. Building into dist/ here would
// race with test/e2e.test.ts, which rebuilds dist/ while the other test files run.
function buildProductCli(): string {
  const out = join(tmp("pilot-product-"), "cli.js");
  const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.build as string;
  const cli = script.split(" && ")[0];
  assert.match(cli, /^esbuild src\/cli\/main\.ts .*--outfile=dist\/cli\.js/, "the build script still builds the CLI first");
  execFileSync("sh", ["-c", cli.replace("--outfile=dist/cli.js", `--outfile='${out}'`)], { cwd: ROOT, env: { PATH: `${join(ROOT, "node_modules", ".bin")}:${env.PATH}` }, stdio: "pipe" });
  return out;
}

const cli = buildProductCli();
const run = (args: string[], cwd = ROOT) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, cwd });

test("npx synthe pilot help lists the pilot's commands under the name a product user types", () => {
  const help = run(["pilot", "help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /keep \/ hold \/ revert/);
  assert.match(help.stdout, /npx synthe pilot <command>/);
  assert.ok(!help.stdout.includes("node src/pilot/cli.ts"), "the product help never tells a user to run a file from a checkout");
  assert.match(help.stdout, /https:\/\/github\.com\/synthelabs\/synthe\/blob\/main\/docs\/PILOT\.md/);
  // With no command it prints the same help and fails, so a script that forgot the command does not pass.
  const bare = run(["pilot"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /npx synthe pilot <command>/);
});

test("npx synthe pilot demo runs the whole synthetic pilot from the product bundle, with no credentials", () => {
  const out = join(tmp("pilot-product-demo-"), "run");
  const demo = run(["pilot", "demo", "--out", out], tmp("pilot-product-cwd-"));
  assert.equal(demo.status, 0, demo.stdout.split("\n").filter((l) => l.includes("FAIL")).join("\n") + demo.stderr);
  assert.match(demo.stdout, /every expectation held/);
  assert.match(demo.stdout, /\$ npx synthe pilot init --config/);
  assert.match(readFileSync(join(out, "pilot", "reports", "PILOT.md"), "utf8"), /KEEP/);
});

test("a wrong pilot command or option fails and points at the product help", () => {
  const unknown = run(["pilot", "launch"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /"launch" is not a pilot command\. Run `npx synthe pilot help`/);
  const option = run(["pilot", "status", "--no-such-option"]);
  assert.equal(option.status, 1);
  assert.match(option.stdout, /Run `npx synthe pilot help` for the options/);
  // A refusal is the pilot's own message and exit code, not the product CLI's generic error.
  const empty = run(["pilot", "status", "--dir", join(tmp("pilot-product-empty-"), "none")]);
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /Refused \(not_found\): No pilot is set up/);
  assert.equal(empty.stderr, "");
});

test("the product help names the pilot, and the other commands still answer as before", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npx synthe pilot help/);
  assert.match(help.stdout, /npx synthe pilot demo --out DIR/);
  assert.match(help.stdout, /npx synthe init {5}set up this repo and start/);
  // A command that needs a set-up project still says so; the pilot wiring did not change that path.
  const status = run(["status"], tmp("pilot-product-status-"));
  assert.match(status.stdout, /Synthe isn't set up in this folder/);
  assert.equal(status.status, 1, "status in a folder with no setup still fails, as on main");
});

test("the product CLI loads the pilot only when the pilot command runs", () => {
  const source = readFileSync(join(ROOT, "src", "cli", "main.ts"), "utf8");
  assert.ok(!/^import .*from "\.\.\/pilot\//m.test(source), "src/cli/main.ts must not import the pilot at load time");
  assert.match(source, /await import\("\.\.\/pilot\/main\.ts"\)/);
});

test("the same command runs straight from source", () => {
  const help = spawnSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), "pilot", "help"], { encoding: "utf8", env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /npx synthe pilot <command>/);
});
