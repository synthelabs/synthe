import type { Goal } from "./goal.ts";

// One line for `status` and setup when the model that writes the prompt edits also judges them. A model tends to favour
// replies written like its own, so the judge may reward what the writer is good at instead of what the team wants.
export function sameModelNote(models: Goal["models"]): string | null {
  return models.writer === models.judge
    ? `Your writer and judge are both ${models.writer}. A separate judge model is safer, because a model tends to favour replies like its own. Set "models.judge" in synthe.json to a different model.`
    : null;
}
