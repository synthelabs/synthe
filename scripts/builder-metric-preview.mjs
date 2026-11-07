import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Local experiment for trusted repositories and trusted adapters.
 * runAgent receives the product request and can edit only its assigned snapshot
 * by convention; this helper is not a process sandbox. measure belongs to the
 * experiment owner and must not use an evaluator supplied by the candidate.
 * No model, provider, deployment or merge is configured by default.
 */
export async function compareBuilderPrompts({
  repo, baselinePrompt, candidatePrompt, runAgent, measure, direction = "higher",
}) {
  if (![baselinePrompt, candidatePrompt].every((prompt) => typeof prompt === "string" && prompt.trim())
    || baselinePrompt === candidatePrompt) throw new Error("Provide two distinct product prompts.");
  if (!["higher", "lower"].includes(direction)) throw new Error("Use higher or lower for the metric.");
  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repo, encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["archive", "--format=tar", commit], { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
  const scratch = mkdtempSync(join(tmpdir(), "synthe-builder-"));
  try {
    const baselineDir = join(scratch, "baseline");
    const candidateDir = join(scratch, "candidate");
    // Prepare both starting trees before either agent executes.
    for (const directory of [baselineDir, candidateDir]) {
      mkdirSync(directory);
      execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
    }
    const trial = async (cwd, prompt) => {
      await runAgent({ cwd, prompt, commit });
      const result = await measure({ cwd, commit });
      if (!Number.isFinite(result?.value) || typeof result?.guardsPassed !== "boolean") {
        throw new Error("The evaluator must return a finite metric and a boolean guardsPassed.");
      }
      return { value: result.value, guardsPassed: result.guardsPassed };
    };
    const baseline = await trial(baselineDir, baselinePrompt);
    const candidate = await trial(candidateDir, candidatePrompt);
    const delta = candidate.value - baseline.value;
    const improved = direction === "higher" ? delta > 0 : delta < 0;
    return { commit, direction, baseline, candidate, delta, observedImprovement: improved && candidate.guardsPassed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
