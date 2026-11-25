// Measure: start at 100 points and take points away for each problem a new user meets in the guide.
// The last number printed is the score.
const fs = require("fs");
const path = require("path");
const text = fs.readFileSync(path.join(__dirname, "..", "SETUP.md"), "utf8");
const problems = [];

// Prose only: no headings, no code, no list markers.
const prose = text.split("\n").filter((l) => !/^\s*(#|```)/.test(l)).map((l) => l.replace(/^\s*(\d+\.|[-*])\s+/, "")).join(" ");
for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  if (words > 25) problems.push({ cost: 10, what: `a sentence of ${words} words (more than 25)` });
}
for (const section of ["Install", "Configure", "Run", "Troubleshoot"]) {
  if (!new RegExp(`^## ${section}\\b`, "m").test(text)) problems.push({ cost: 15, what: `no "## ${section}" section` });
}
for (const _ of text.match(/\bTODO\b/g) || []) problems.push({ cost: 5, what: "an open TODO note" });

let score = 100;
for (const p of problems) { score -= p.cost; console.log(`-${p.cost} ${p.what}`); }
console.log(score);
