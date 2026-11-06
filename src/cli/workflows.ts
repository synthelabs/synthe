import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DIAGNOSTICS_FILE = ".github/workflows/synthe-diagnostics.yml";
const DIAGNOSTICS_HEADER = "# Synthe Crimson event completion workflow.";
export const CRIMSON_NOTICE = "Crimson Hacks requires workflow tracking for enrolled teams, even when your own key pays for model calls. The organizers receive the repository name and ID, workflow run ID and attempt, start and finish times, and the workflow-reported outcome. Your sharing settings still control prompt, test case, and other research data.";

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
    .replace("  # __CRIMSON_END__\n", enabled ? END_JOB : "");
}

// GitHub never starts the completion workflow (on: workflow_run) for runs started with GITHUB_TOKEN, and the round
// chain starts every round after a team's first that way. So the run reports its own end, from its last job. The job
// may fail without failing the run, and the Action only warns when the receipt isn't acknowledged.
const END_JOB = `  end:
    needs: [write, score, decide]
    if: \${{ always() && needs.write.result != 'skipped' }}
    runs-on: ubuntu-latest
    timeout-minutes: 2
    continue-on-error: true
    permissions: { id-token: write }
    steps:
      - name: Record Crimson run end
${receiptInputs}
          step: receipt-end
          conclusion: \${{ contains(needs.*.result, 'failure') && 'failure' || contains(needs.*.result, 'cancelled') && 'cancelled' || 'success' }}
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
