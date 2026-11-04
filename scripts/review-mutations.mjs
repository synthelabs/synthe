import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const mutations = [
  ["interactive setup overwrites an installed repo", "src/cli/init.ts", "if (installed.every(Boolean))", "if (agent && installed.every(Boolean))"],
  ["Haiku long-context tier is ignored", "src/core/cost.ts", 'model === "claude-haiku-5-5" && totalInput > 100_000', "false"],
  ["confirmation accepts a changed prompt", "src/cli/init.ts", "if (draft.sourceHash !== sha256(source))", "if (false)"],
  ["app key beats event credit", "src/cli/init.ts", 'env.SYNTHE_EVENT_CODE?.trim() || appKey?.trim()', 'appKey?.trim() || env.SYNTHE_EVENT_CODE?.trim()'],
  ["confirmation ignores DO_NOT_TRACK", "src/cli/init.ts", 'if (sharingDisabled(env)) draft.goal.share = "none";', ''],
  ["confirmation ignores --share", "src/cli/init.ts", 'if (agent.share) draft.goal.share = agent.share;', ''],
  ["key never records the budget switch", "src/cli/key.ts", 'state.ownKeyFromUsd = state.spendUsd;', ''],
  ["budget still charges event spend", "src/core/state.ts", 'state.spendUsd - (state.ownKeyFromUsd ?? 0)', 'state.spendUsd'],
  ["restart rejects a fresh or raised budget", "src/cli/restart.ts", '&& !budgetAvailable', ''],
  ["closed stdin succeeds without a key", "src/cli/key.ts", 'io.say("Ask the person to run `npx synthe key` in their own terminal.");\n    return false;', 'io.say("Ask the person to run `npx synthe key` in their own terminal.");\n    return true;'],
  ["key skips the cheap test call", "src/cli/key.ts", 'await (io.model ?? anthropicModel)(key).ask({ model: "claude-haiku-5-5", user: "Say OK.", maxTokens: 5 });', ''],
  ["key saves despite failed validation", "src/cli/key.ts", 'io.say(`${modelProblem(error) ?? (error as Error).message} Nothing changed.`);\n    return false;', 'io.say(`${modelProblem(error) ?? (error as Error).message} Nothing changed.`);'],
  ["survivor: key accepts non-sk-ant input", "src/cli/key.ts", 'if (!/^sk-ant-\\S+$/.test(key))', 'if (false)'],
  ["survivor: report drops credit next step", "src/loop/report.ts", 'if (state.stopped === "credit") steps.push("To use your own Anthropic key, run `npx synthe key`, then `npx synthe restart`.");', 'if (state.stopped === "credit") {}'],
  ["survivor: step 2 skips credential-type match", "src/cli/init.ts", 'if (draft.event !== !credential.startsWith("sk-ant-")) askPerson("--confirm (use the same credential type as step 1)");', ''],
  ["confirmation leaves the draft behind", "src/cli/init.ts", 'if (finished) rmSync(join(root, DRAFT_FILE), { force: true });', ''],
  ["agent setup can repeat", "src/cli/init.ts", 'if (installed.every(Boolean))', 'if (false)'],
  ["proxy authentication is blamed on the key", "src/model/client.ts", 'if (refused.status === 401) throw new ProxyError(401, PROXY_AUTH_MESSAGE);', ''],
  ["proxy ledger outage loses its message", "src/model/client.ts", 'if (refused.status === 503 && typeof refused.error?.error?.message === "string") throw new ProxyError(503, refused.error.error.message);', ''],
  ["Action skips upfront OIDC validation", "src/action.ts", 'requireOidc();', 'void 0;'],
  ["OIDC token cache is ignored", "src/core/share.ts", 'cached.expires - 60_000 > Date.now()', 'false'],
  ["proxy retries four times", "src/model/client.ts", 'maxRetries: 2, logLevel: "off"', 'maxRetries: 4, logLevel: "off"'],
  ["agent sees an interactive paste prompt", "src/cli/init.ts", 'if (!agent) io.say("\\nOptional:', 'io.say("\\nOptional:'],
];

const originals = new Map(mutations.map(([, path]) => [path, readFileSync(path, "utf8")]));
const runTests = () => spawnSync(process.execPath, ["--test", "test/review.test.ts", "test/core.test.ts", "test/init.test.ts"], { encoding: "utf8", timeout: 60_000 });
const baseline = runTests();
assert.equal(baseline.status, 0, `Regression baseline failed:\n${baseline.stdout}\n${baseline.stderr}`);
let killed = 0;
try {
  for (const [name, path, from, to] of mutations) {
    const original = originals.get(path);
    assert.ok(original.includes(from), `STALE: ${name}`);
    const restore = () => writeFileSync(path, original);
    process.once("SIGINT", restore);
    try {
      writeFileSync(path, original.replace(from, to));
      const result = runTests();
      const detected = result.status !== null && result.status !== 0 && !/SyntaxError|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/.test(result.stdout + result.stderr);
      if (detected) killed++;
      console.log(`${detected ? "killed" : "SURVIVED"}: ${name}`);
    } finally {
      restore();
      process.removeListener("SIGINT", restore);
    }
  }
} finally {
  for (const [path, original] of originals) writeFileSync(path, original);
}
console.log(`${killed}/${mutations.length} review mutations killed`);
process.exitCode = killed === mutations.length ? 0 : 1;
