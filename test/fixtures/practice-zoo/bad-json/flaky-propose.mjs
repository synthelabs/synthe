// A proposer that misbehaves on purpose. Before each menu proposal it gives one bad reply in turn: text that is not
// JSON, a proposal with no edits, and a crash. Synthe must record each as a failed attempt and go on.
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const menu = JSON.parse(readFileSync(new URL("./menu.json", import.meta.url), "utf8"));
const bad = [
  () => process.stdout.write("Sure! Here is my idea: {proposals: [raise it"),
  () => process.stdout.write(JSON.stringify({ proposals: [{ summary: "a proposal with no edits" }] })),
  () => { process.stderr.write("the proposer crashed"); process.exit(2); },
];
const step = input.history.length;
if (step % 2 === 0 && step / 2 < bad.length) bad[step / 2]();
else {
  const tried = new Set(input.history.map((h) => h.summary));
  process.stdout.write(JSON.stringify({ proposals: menu.filter((p) => !tried.has(p.summary)).slice(0, input.candidates) }));
}
