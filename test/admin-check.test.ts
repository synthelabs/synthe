import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, notAdmin, type Io } from "../src/cli/init.ts";
import { agentOptions } from "../src/cli/agent.ts";

const TEAM = "crim-aaaa-bbbb-cccc-dddd";
const env = { SYNTHE_EVENT_CODE: "crimson", SYNTHE_TEAM_CODE: TEAM };
const draft = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be helpful", "--mode", "auto"]);
const confirm = agentOptions(["--agent", "--confirm", "--keep-checks"]);

// On a hackathon team the person at the keyboard is often a collaborator, not the repo's owner. Setup saves repo
// secrets and changes an Actions setting, which only admins may do, so it has to say so before anything is spent.
function repo(context: { after: (fn: () => void) => void }, access: string | Error) {
  const root = mkdtempSync(join(tmpdir(), "synthe-admin-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "prompt.md"), "You help hikers pick safe trails.");
  const said: string[] = [];
  const ran: string[][] = [];
  let modelCalls = 0;
  const io: Io = {
    say: (message) => said.push(message),
    ask: async () => "",
    askSecret: async () => "",
    run: async (command, args) => {
      ran.push([command, ...args]);
      if (args.includes("viewerPermission")) { if (access instanceof Error) throw access; return `${access}\n`; }
      if (command === "git") return args[0] === "ls-files" ? "prompt.md" : args[0] === "rev-parse" ? "main" : "";
      if (args.includes("nameWithOwner")) return "team/repo";
      if (args.includes("defaultBranchRef")) return "main";
      return "";
    },
    model: () => ({ ask: async () => { modelCalls++; throw new Error("no model call expected"); } }),
    proxy: () => ({ ask: async () => { modelCalls++; throw new Error("no model call expected"); } }),
    template: () => "uses: __ACTION__\ncron: __MINUTE__",
    sleep: async () => {},
  };
  return { root, io, said, ran, models: () => modelCalls };
}

for (const access of ["WRITE", "MAINTAIN", "TRIAGE", "READ"]) {
  test(`setup stops before spending or writing anything for ${access.toLowerCase()} access`, async (context) => {
    for (const agent of [undefined, draft, confirm]) {
      const { root, io, said, ran, models } = repo(context, access);
      assert.equal(await init(io, root, undefined, undefined, env, agent), false);
      assert.equal(said.at(-1), notAdmin("team/repo", access));
      assert.equal(models(), 0);
      assert.ok(!ran.some((call) => call.includes("secret")), "no secret is touched");
      assert.ok(!existsSync(join(root, ".synthe")) && !existsSync(join(root, ".gitignore")), "nothing is written");
    }
  });
}

test("the message names the repo, the access, the fix, and that nothing changed", () => {
  const text = notAdmin("team/repo", "WRITE");
  assert.match(text, /Only an admin of team\/repo can set up Synthe/);
  assert.match(text, /has write access/);
  assert.match(text, /Ask the repo's owner to run setup, or to make you an admin \(Settings, then Collaborators\)/);
  assert.ok(text.endsWith("Nothing was changed."));
});

test("admin access, or no answer from GitHub, goes on to the next step", async (context) => {
  for (const access of ["ADMIN", "", new Error("gh: network")]) {
    const { root, io, said } = repo(context, access);
    await init(io, root, undefined, undefined, env, draft).catch(() => false);
    assert.ok(!said.some((line) => line.startsWith("Only an admin")), `access ${String(access)} must not be refused`);
  }
});
