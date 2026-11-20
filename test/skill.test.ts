import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// skills/synthe/SKILL.md is what `npx skills add synthelabs/synthe` installs into a team's coding agent.
// It only points at `npx synthe@latest guide`, so the guide stays the one source of setup steps.
// These tests stop it from turning into a second copy that drifts, or a pin that goes stale:
// scripts/version-pins.mjs moves pins only in README.md and docs/AGENT-SETUP.md.
const folder = "synthe";
const skill = readFileSync(`skills/${folder}/SKILL.md`, "utf8");
const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
const body = front ? skill.slice(front[0].length) : "";

// Plain `key: value`, or a folded `key: >-` block whose indented lines join with spaces. No YAML parser:
// the skill's frontmatter is two keys, and a parser would be a new dependency.
function field(yaml: string, key: string): string | undefined {
  const lines = yaml.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at < 0) return undefined;
  const value = lines[at].slice(key.length + 1).trim();
  if (value !== ">-" && value !== ">") return value;
  const block: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(line)) break;
    block.push(line.trim());
  }
  return block.join(" ");
}

test("SKILL.md has the frontmatter the skills CLI needs", () => {
  assert.ok(front, "SKILL.md must start with a --- frontmatter block");
  const name = field(front[1], "name");
  // The Agent Skills spec: lowercase letters, digits and single hyphens, equal to the folder name.
  assert.equal(name, folder);
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  const description = field(front[1], "description");
  assert.ok(description, "description is required");
  assert.ok(description.length <= 1024, `description is ${description.length} characters; the spec allows 1024`);
  assert.match(description, /set up Synthe/i);
});

test("SKILL.md sends the agent to the guide and pins no version", () => {
  assert.match(body, /npx --yes synthe@latest guide/);
  assert.doesNotMatch(skill, /synthe#v\d|synthe@\d/);
});

test("SKILL.md does not copy lines of the guide", () => {
  const guide = readFileSync("docs/AGENT-SETUP.md", "utf8");
  const copied = guide.split("\n").map((line) => line.trim()).filter((line) => line.length >= 40 && skill.includes(line));
  assert.deepEqual(copied, []);
});

test("the guide command the skill names prints the setup guide", () => {
  const out = execFileSync("node", ["src/cli/main.ts", "guide"], { encoding: "utf8" });
  assert.equal(out.trim(), readFileSync("docs/AGENT-SETUP.md", "utf8").trim());
});
