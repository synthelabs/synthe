// The enterprise pilot's entry point. Run it from a checkout:
//
//   node src/pilot/cli.ts <command> --dir <pilot directory> [options]
//   node src/pilot/cli.ts demo --out <directory>        the whole loop on synthetic data, no credentials
//
// It is deliberately not wired into `npx synthe` yet (src/cli/main.ts and the committed bundles belong to other
// work in flight); docs/PILOT.md lists the wiring that remains. `node scripts/pilot-build.mjs` bundles this file.
// Everything lives in main.ts; this file only runs it, so importing the pilot from elsewhere never starts a command.
import { defaultDeps, main } from "./main.ts";

main(process.argv.slice(2), defaultDeps()).then(
  (code) => { process.exitCode = code; },
  () => { console.error("The pilot command hit an unexpected error and stopped."); process.exitCode = 1; },
);
