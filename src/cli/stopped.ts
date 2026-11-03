export const STOPPED_LINE = "Stopped with npx synthe stop. Nothing more will run or change. To start it again: gh workflow enable synthe.yml";

// Stop disables the workflow, but the old run state stays readable, so status needs to say so first.
// Only a manual stop gets this line. If the check fails, status prints as before.
export async function stoppedLine(run: (cmd: string, args: string[]) => Promise<string>, slug: string): Promise<string | null> {
  try {
    const state = (await run("gh", ["api", `repos/${slug}/actions/workflows/synthe.yml`, "--jq", ".state"])).trim();
    return state === "disabled_manually" ? STOPPED_LINE : null;
  } catch {
    return null;
  }
}
