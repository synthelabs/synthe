import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The enterprise pilot is a paid product outside this package. The command name stays reserved and says so.
const MESSAGE = "The enterprise pilot is not part of this package. Contact the Synthe team.";

test("npx synthe pilot prints that the pilot is not part of this package and exits 1", () => {
  for (const args of [["pilot"], ["pilot", "demo", "--out", "x"]]) {
    const r = spawnSync(process.execPath, ["src/cli/main.ts", ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, `exit code for ${args.join(" ")}`);
    assert.equal(`${r.stdout}${r.stderr}`.trim(), MESSAGE);
  }
});

test("the help no longer lists pilot commands", () => {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", "help"], { encoding: "utf8" });
  assert.doesNotMatch(r.stdout, /pilot/i);
});

test("the build removes the retired pilot wrapper files from dist/", () => {
  // The Swarm merge job rebuilds dist/ with `npm run build` and `git add dist`, so the build itself must delete them.
  const r = spawnSync(process.execPath, ["scripts/build.mjs"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const file of ["wrap.mjs", "wrap.cjs", "wrap.d.ts", "wrap.d.cts"]) assert.equal(existsSync(join("dist", file)), false, `dist/${file}`);
  assert.equal(existsSync(join("dist", "cli.js")), true);
});
