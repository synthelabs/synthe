// The setup docs tell people and agents to run an exact tagged CLI (`npx --yes github:synthelabs/synthe#vX`).
// Those pins went stale once: 1.8.x shipped while the guide still installed 1.7.5. `npm version` runs this
// script (the "version" hook), which points every pin at the new version and regenerates src/cli/guide.ts.
// The publish check refuses a package whose pins name another version.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PIN_FILES = ["README.md", "docs/AGENT-SETUP.md", "kit/HACKATHON.md"];
const PIN = /github:synthelabs\/synthe#v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g;

export const setPins = (text, version) => text.replace(PIN, `github:synthelabs/synthe#v${version}`);

// Every pin that names another version, as "file: vX".
export function pinProblems(version, files) {
  return Object.entries(files).flatMap(([file, text]) =>
    [...text.matchAll(PIN)].filter((m) => m[1] !== version).map((m) => `${file}: v${m[1]}`));
}

// src/cli/guide.ts carries docs/AGENT-SETUP.md as a string (the CLI must also run from source, and Node cannot
// import a .md file). Keep its header comment and replace only the string.
export function guideSource(current, doc) {
  const at = current.indexOf("export const guide = ");
  if (at < 0) throw new Error("src/cli/guide.ts has no `export const guide = ` line");
  return `${current.slice(0, at)}export const guide = ${JSON.stringify(doc)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const read = (file) => readFileSync(new URL(file, root), "utf8");
  const { version } = JSON.parse(read("package.json"));
  for (const file of PIN_FILES) writeFileSync(new URL(file, root), setPins(read(file), version));
  writeFileSync(new URL("src/cli/guide.ts", root), guideSource(read("src/cli/guide.ts"), read("docs/AGENT-SETUP.md")));
  console.log(`Pinned ${PIN_FILES.join(", ")} and src/cli/guide.ts to v${version}.`);
}
