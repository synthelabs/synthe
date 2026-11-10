import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION, CRIMSON_ACTION, renderWorkflow, WORKFLOW_FILE } from "./init.ts";
import { CRIMSON_NOTICE, DIAGNOSTICS_FILE, previousDiagnostics, renderCrimsonDiagnostics } from "./workflows.ts";

// Replace the installed workflow files. Keep the team's backup minute and all other files intact.
export function upgrade(root: string, template: string, enroll = false): string {
  const path = join(root, WORKFLOW_FILE);
  if (!existsSync(path)) throw new Error(`No ${WORKFLOW_FILE} found. Run \`npx synthe init\` first.`);
  const before = readFileSync(path, "utf8");
  if (!before.includes(ACTION)) throw new Error(`${WORKFLOW_FILE} is not a Synthe workflow; left it unchanged.`);
  const cron = before.match(/cron:\s*["']?(\d+)(?:-59\/10)? \* \* \* \*/);
  const minute = cron ? Math.max(1, Number(cron[1])) : undefined;
  const event = enroll || before.includes("step: receipt-start");
  const after = renderWorkflow(template, Math.random, minute, event);
  const diagnostics = event ? renderCrimsonDiagnostics(CRIMSON_ACTION) : null;
  const diagnosticsChanged = diagnostics !== null && previousDiagnostics(root) !== diagnostics;
  if (after === before && !diagnosticsChanged) return `${WORKFLOW_FILE} is already up to date. No files changed.`;
  if (diagnosticsChanged) writeFileSync(join(root, DIAGNOSTICS_FILE), diagnostics);
  if (after !== before) writeFileSync(path, after);
  if (event) return `Updated the Crimson workflows. ${CRIMSON_NOTICE} Commit ${WORKFLOW_FILE} and ${DIAGNOSTICS_FILE}, then push both to the default branch. Set both event and team secrets before starting a round.`;
  return `Updated ${WORKFLOW_FILE}: rounds now chain immediately, a cancelled run no longer counts as a round, sharing (if you turned it on) can prove which repo sent it, and event credit works through the Synthe proxy; kept backup minute ${minute ?? "random"}. No other files changed. Commit and push this workflow file to activate it.`;
}
