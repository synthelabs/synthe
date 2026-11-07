import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCodingAgent, createCodingAgent } from "../src/builder/agent.ts";

async function fixture(script: string) {
  const cwd = await mkdtemp(join(tmpdir(), "synthe-agent-test-"));
  const executable = join(cwd, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 });
  return { cwd, executable, remove: () => rm(cwd, { recursive: true, force: true }) };
}

test("passes the prompt over stdin and isolates credentials and sandbox settings", async (t) => {
  const { cwd, executable, remove } = await fixture(`
    const {readFileSync, writeFileSync} = require("node:fs");
    if (["--version", "--help", "status"].some(flag => process.argv.includes(flag))) process.exit(0);
    writeFileSync("invocation.json", JSON.stringify({
      args: process.argv.slice(2), cwd: process.cwd(), input: readFileSync(0, "utf8"),
      envNames: Object.keys(process.env),
    }));
  `);
  t.after(remove);
  const keyNames = ["SYNTHE_EVENT_CODE", "SYNTHE_TEAM_CODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"];
  for (const key of keyNames) {
    const previous = process.env[key];
    process.env[key] = "synthetic-only-secret";
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  await checkCodingAgent("codex", { executable });
  const prompt = "Make signup finish after one click.\n";
  await createCodingAgent("codex", { executable })(cwd, prompt);
  const invocation = JSON.parse(await readFile(join(cwd, "invocation.json"), "utf8"));
  assert.equal(invocation.cwd, await realpath(cwd));
  assert.equal(invocation.input, prompt);
  assert.deepEqual(invocation.args.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
  assert.ok(invocation.args.includes("workspace-write"));
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(invocation.args.includes("mcp_servers={}"));
  assert.ok(invocation.args.includes("browser_use"));
  assert.equal(invocation.args.at(-1), "-");
  assert.equal(invocation.args.join(" ").includes(prompt.trim()), false);
  assert.equal(invocation.envNames.some((key: string) => keyNames.includes(key)), false);
});

test("stops a stalled trial and never prints subprocess output", async (t) => {
  const slow = await fixture("setInterval(() => {}, 1000);");
  const failed = await fixture('console.error("secret-output"); process.exit(1);');
  t.after(slow.remove);
  t.after(failed.remove);
  await assert.rejects(
    createCodingAgent("codex", { executable: slow.executable, timeoutMs: 150 })(slow.cwd, "Change the button."),
    /trial time limit/,
  );
  await assert.rejects(
    createCodingAgent("codex", { executable: failed.executable })(failed.cwd, "Change the button."),
    (error: Error) => /did not complete the trial/.test(error.message) && !error.message.includes("secret-output"),
  );
});

test("rejects unsupported agents without a subprocess", async () => {
  assert.throws(() => createCodingAgent("claude"), /not supported/);
  await assert.rejects(checkCodingAgent("claude"), /not supported/);
});

test("preflight refuses an incompatible executable before checking login", async (t) => {
  const { executable, remove } = await fixture(`
    if (process.argv.includes("--help")) process.exit(2);
    if (process.argv.includes("status")) throw new Error("unexpected sign-in check");
  `);
  t.after(remove);
  await assert.rejects(checkCodingAgent("codex", { executable }), /Update the local Codex CLI/);
});
