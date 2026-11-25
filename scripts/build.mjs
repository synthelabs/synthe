// Builds dist/: the CLI (dist/cli.js) and the action (dist/action.mjs).
// Every file is written to a temporary folder inside dist/ first and then renamed into place. A rename in the same
// folder is atomic, so a process that starts dist/cli.js while a build runs gets the old file or the new one, never a
// half-written one. test/e2e.test.ts rebuilds dist/ while other test files start dist/cli.js, and a half-written file
// made those tests fail at random.
//
// `node scripts/build.mjs --cli <file>` builds only the CLI, with the same options, to a file of the caller's own.
// Tests and dev scripts that need a CLI bundle use it, so they never read dist/ while another process rebuilds it.
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const common = { bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" };
const buildCli = (outfile) => build({ ...common, entryPoints: [join(root, "src/cli/main.ts")], outfile, loader: { ".md": "text" }, banner: { js: "#!/usr/bin/env node" } });

if (process.argv[2] === "--cli") {
  if (!process.argv[3]) throw new Error("Usage: node scripts/build.mjs --cli <file>");
  await buildCli(resolve(process.argv[3]));
} else {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const tmp = mkdtempSync(join(dist, ".build-"));
  try {
    await buildCli(join(tmp, "cli.js"));
    await build({ ...common, entryPoints: [join(root, "src/action.ts")], outfile: join(tmp, "action.mjs") });
    for (const file of readdirSync(tmp)) renameSync(join(tmp, file), join(dist, file));
    // The pilot's package entry left this package in 1.11.0. dist/ is committed and the merge job rebuilds it with
    // `npm run build` and `git add dist`, so the build removes the old files; otherwise they would stay in the package.
    for (const file of ["wrap.mjs", "wrap.cjs", "wrap.d.ts", "wrap.d.cts"]) rmSync(join(dist, file), { force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
