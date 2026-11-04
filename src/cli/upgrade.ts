import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderWorkflow, WORKFLOW_FILE } from "./init.ts";

// Replace only the installed workflow. Keep the team's backup minute and all other files intact.
export function upgrade(root: string, template: string): string {
  const path = join(root, WORKFLOW_FILE);
  if (!existsSync(path)) throw new Error(`No ${WORKFLOW_FILE} found. Run \`npx synthe init\` first.`);
  const before = readFileSync(path, "utf8");
  if (!before.includes("synthelabs/synthe@v1")) throw new Error(`${WORKFLOW_FILE} is not a Synthe workflow; left it unchanged.`);
  const cron = before.match(/cron:\s*["']?(\d+)(?:-59\/10)? \* \* \* \*/);
  const minute = cron ? Math.max(1, Number(cron[1])) : undefined;
  const after = renderWorkflow(template, Math.random, minute);
  if (after === before) return `${WORKFLOW_FILE} is already up to date. No files changed.`;
  writeFileSync(path, after);
  return `Updated ${WORKFLOW_FILE}: rounds now chain immediately, a cancelled run no longer counts as a round, and sharing (if you turned it on) can prove which repo sent it; kept backup minute ${minute ?? "random"}. No other files changed. Commit and push this workflow file to activate it.`;
}
