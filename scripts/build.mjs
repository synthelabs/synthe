// Builds the two bundles: dist/cli.js (npx synthe) and dist/action.mjs (the GitHub Action). A script rather than a
// shell command line, so the build is the same on Windows, where cmd.exe doesn't understand the quotes a banner needs.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" };
await build({ ...common, entryPoints: ["src/cli/main.ts"], outfile: "dist/cli.js", banner: { js: "#!/usr/bin/env node" } });
await build({ ...common, entryPoints: ["src/action.ts"], outfile: "dist/action.mjs" });
