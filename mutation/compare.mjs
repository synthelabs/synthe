// Kill rates for the existing tests alone and with the Lean differential test, from the two Stryker JSON reports,
// and the mutants that only the Lean test kills. Timeouts count as killed; "NoCoverage" counts as survived.
import { readFileSync } from "node:fs";
const load = (set) => JSON.parse(readFileSync(`mutation/reports/${set}.json`, "utf8")).files;
const KILLED = new Set(["Killed", "Timeout", "RuntimeError", "CompileError"]);
const key = (file, m) => `${file}:${m.location.start.line}:${m.location.start.column}:${m.mutatorName}:${m.replacement ?? ""}`;
const index = (files) => new Map(Object.entries(files).flatMap(([f, v]) => v.mutants.filter((m) => m.status !== "Ignored").map((m) => [key(f, m), { f, m }])));
const ex = index(load("existing")), ln = index(load("with-lean"));
const rate = (map) => { const all = [...map.values()]; const k = all.filter(({ m }) => KILLED.has(m.status)).length; return `${k}/${all.length} (${((100 * k) / all.length).toFixed(1)}%)`; };
console.log(`existing tests alone:        ${rate(ex)}`);
console.log(`existing + lean-spec.test:   ${rate(ln)}`);
const only = [...ln].filter(([k, { m }]) => KILLED.has(m.status) && ex.has(k) && !KILLED.has(ex.get(k).m.status));
console.log(`killed only with Lean: ${only.length}`);
for (const [, { f, m }] of only) console.log(`  ${f}:${m.location.start.line} ${m.mutatorName}: ${JSON.stringify(m.replacement)}`);
const both = [...ln].filter(([k, { m }]) => !KILLED.has(m.status) && (!ex.has(k) || !KILLED.has(ex.get(k).m.status)));
console.log(`survive both: ${both.length}`);
for (const [, { f, m }] of both) console.log(`  ${f}:${m.location.start.line} ${m.mutatorName}: ${JSON.stringify(m.replacement)}`);
