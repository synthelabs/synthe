import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION, renderWorkflow, WORKFLOW_FILE } from "./init.ts";

// A second workflow that older setups added for event tracking. Synthe no longer uses it.
const OLD_TRACKING_FILE = ".github/workflows/synthe-diagnostics.yml";

// Replace the installed workflow files. Keep the team's backup minute and all other files intact.
export function upgrade(root: string, template: string): string {
  const path = join(root, WORKFLOW_FILE);
  if (!existsSync(path)) throw new Error(`No ${WORKFLOW_FILE} found. Run \`npx synthe init\` first.`);
  const before = readFileSync(path, "utf8");
  if (!before.includes(ACTION)) throw new Error(`${WORKFLOW_FILE} is not a Synthe workflow; left it unchanged.`);
  const cron = before.match(/cron:\s*["']?(\d+)(?:-59\/10)? \* \* \* \*/);
  const minute = cron ? Math.max(1, Number(cron[1])) : undefined;
  const after = renderWorkflow(template, Math.random, minute);
  const old = existsSync(join(root, OLD_TRACKING_FILE)) ? ` You can delete ${OLD_TRACKING_FILE}; Synthe no longer uses it.` : "";
  if (after === before) return `${WORKFLOW_FILE} is already up to date. No files changed.${old}`;
  writeFileSync(path, after);
  return `Updated ${WORKFLOW_FILE}: rounds now chain immediately, a cancelled run no longer counts as a round, and sharing (if you turned it on) can prove which repo sent it; kept backup minute ${minute ?? "random"}. No other files changed. Commit and push this workflow file to activate it.${old}`;
}
