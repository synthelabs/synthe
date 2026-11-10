import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DIAGNOSTICS_FILE = ".github/workflows/synthe-diagnostics.yml";
const DIAGNOSTICS_HEADER = "# Synthe Crimson event completion workflow.";
export const CRIMSON_NOTICE = "Crimson Hacks requires workflow tracking for enrolled teams, even when your own key pays for model calls. The organizers receive the repository name and ID, workflow run ID and attempt, start and finish times, and the workflow-reported outcome. Your sharing settings still control the prompt, test case and other research data that workflow rounds send.";

const receiptInputs = `        uses: __ACTION__
        with:
          github-token: \${{ github.token }}
          event-code: \${{ secrets.SYNTHE_EVENT_CODE }}
          team-code: \${{ secrets.SYNTHE_TEAM_CODE }}`;

export function renderCrimsonPreflight(template: string, enabled: boolean): string {
  const step = (rerun = false) => `      - name: Record Crimson run start
        id: crimson_receipt
${rerun ? "        if: github.run_attempt != '1'\n" : ""}${receiptInputs}
          step: receipt-start
`;
  const decideGate = "needs.write.outputs.go != 'false'";
  return template
    .replaceAll("\r\n", "\n")
    .replace("      # __CRIMSON_PREFLIGHT__\n", enabled ? step() : "")
    .replaceAll("      # __CRIMSON_RERUN_PREFLIGHT__\n", enabled ? step(true) : "")
    .replace("      # __CRIMSON_WRITE_OUTPUT__\n", enabled ? "      receipt: ${{ steps.crimson_receipt.outcome }}\n" : "")
    .replace(decideGate, enabled ? decideGate + " && needs.write.outputs.receipt == 'success'" : decideGate)
    .replace("  # __CRIMSON_FINISH__\n", enabled ? finishJob : "");
}

// GitHub never starts the completion workflow for runs started with GITHUB_TOKEN, so chained rounds report their
// own finish. It runs after a started round however it ended, and a tracking problem never fails the round itself.
const finishJob = `  finish:
    needs: [write, score, decide]
    if: \${{ always() && needs.write.result != 'skipped' }}
    runs-on: ubuntu-latest
    timeout-minutes: 2
    continue-on-error: true
    permissions: { id-token: write }
    steps:
      - name: Record Crimson run finish
${receiptInputs}
          step: receipt-finish
          conclusion: \${{ contains(needs.*.result, 'cancelled') && 'cancelled' || contains(needs.*.result, 'failure') && 'failure' || 'success' }}
`;

export function renderCrimsonDiagnostics(action: string): string {
  return `${DIAGNOSTICS_HEADER}
name: Synthe Crimson completion
on:
  workflow_run:
    workflows: [Synthe]
    types: [completed]
permissions: {}
jobs:
  record:
    if: github.event.workflow_run.head_repository.id == github.event.repository.id
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: { id-token: write }
    steps:
      - name: Record Crimson run completion
${receiptInputs.replace("__ACTION__", action)}
          step: receipt-finish
`;
}

export function previousDiagnostics(root: string): string | null {
  const path = join(root, DIAGNOSTICS_FILE);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return null;
  const before = info.isFile() ? readFileSync(path, "utf8") : "";
  if (before.split(/\r?\n/, 1)[0] !== DIAGNOSTICS_HEADER) {
    throw new Error(`${DIAGNOSTICS_FILE} already exists. Move that file before enabling Crimson tracking.`);
  }
  return before;
}
