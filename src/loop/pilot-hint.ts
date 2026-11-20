import type { Repo } from "../github/repo.ts";

// Whether this repo's pilot contract (a pilot.json with a pilot_id) is committed on the default branch. The pilot
// directory itself holds customer data and is kept out of git, so a committed pilot.json is the only trace the
// report can see. Any failure reads as "no pilot": the report line it gates is a hint, never needed.
export async function hasPilot(repo: Repo): Promise<boolean> {
  try {
    const text = await repo.readFile("pilot.json", await repo.headSha(await repo.defaultBranch()));
    return text !== null && typeof (JSON.parse(text) as { pilot_id?: unknown })?.pilot_id === "string";
  } catch {
    return false;
  }
}
