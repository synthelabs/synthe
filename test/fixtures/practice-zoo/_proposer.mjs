// The practice zoo's proposer: it offers the proposals in menu.json in order, the ones not yet tried first, and
// says "nothing more" when every one was tried. Each summary starts with GAIN:, NOOP: or TRAP: so the runner can
// count what was kept by class. Synthe sees only the summary text; it gets no hint from the class.
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const menu = JSON.parse(readFileSync(new URL("./menu.json", import.meta.url), "utf8"));
const tried = new Set(input.history.map((h) => h.summary));
const next = menu.filter((p) => !tried.has(p.summary)).slice(0, input.candidates);
process.stdout.write(JSON.stringify({ proposals: next }));
