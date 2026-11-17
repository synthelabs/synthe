// The enterprise pilot's entry point. Run it from a checkout:
//
//   node src/pilot/cli.ts <command> --dir <pilot directory> [options]
//   node src/pilot/cli.ts demo --out <directory>        the whole loop on synthetic data, no credentials
//
// The product CLI runs the same commands as `npx synthe pilot <command>` (src/cli/main.ts). This file is the entry
// point from a checkout, and `node scripts/pilot-build.mjs` bundles it on its own.
// Everything lives in main.ts; this file only runs it, so importing the pilot from elsewhere never starts a command.
import { defaultDeps, main } from "./main.ts";

main(process.argv.slice(2), defaultDeps()).then(
  (code) => { process.exitCode = code; },
  () => { console.error("The pilot command hit an unexpected error and stopped."); process.exitCode = 1; },
);
