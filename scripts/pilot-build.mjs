#!/usr/bin/env node
// Bundles the enterprise pilot's entry point (src/pilot/cli.ts) into one file, so it can be run without a checkout:
//
//   node scripts/pilot-build.mjs [--outfile <path>]     default: .synthe-local/pilot/synthe-pilot.mjs (git-ignored)
//   node .synthe-local/pilot/synthe-pilot.mjs help
//
// It is separate from `npm run build` on purpose: that script writes the committed bundles in dist/, which belong
// to the released CLI and Action. Nothing here touches dist/ or package.json. The same esbuild options as the main
// build are used, so the wiring that remains (docs/PILOT.md, "What is not wired yet") is a small change.
//
// The build is reproducible: the same source gives the same bytes, and the SHA-256 is printed so two builds can
// be compared.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--outfile");
const outfile = resolve(at > 0 && process.argv[at + 1] ? process.argv[at + 1] : resolve(root, ".synthe-local/pilot/synthe-pilot.mjs"));
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "src/pilot/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  loader: { ".md": "text" },
  banner: { js: "#!/usr/bin/env node" },
  outfile,
  // Paths inside the bundle are relative to the repo, so the bytes do not depend on where the checkout lives.
  absWorkingDir: root,
  logLevel: "warning",
});

const bytes = readFileSync(outfile);
console.log(`Built ${outfile}`);
console.log(`${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
console.log(`Run it with: node ${outfile} help`);
