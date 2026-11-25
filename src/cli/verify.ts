import { verifyEvidence } from "../core/evidence.ts";

// Prints PASS or FAIL with the reason, and returns the exit code. Reads only files, so it works offline.
export function verify(file: string | undefined, root: string, say: (line: string) => void = console.log): number {
  if (!file) {
    say("Say which record to check, for example: npx synthe verify .synthe/evidence/round-3.json");
    return 1;
  }
  const result = verifyEvidence(file, root);
  if (!result.ok) {
    say(`FAIL: ${result.reason}`);
    return 1;
  }
  for (const note of result.notes) say(note);
  say("PASS");
  return 0;
}
