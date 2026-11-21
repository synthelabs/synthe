// Scores docs/guide.md: 10 points for each required section that appears exactly once, 5 for a code example in
// Usage, 5 when no line is longer than 100 characters. Higher is better.
const fs = require("fs");
const path = require("path");
const text = fs.readFileSync(path.join(__dirname, "..", "docs", "guide.md"), "utf8");
const lines = text.split("\n");
const REQUIRED = ["Install", "Usage", "Configuration", "Troubleshooting"];
const headings = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
let score = 0;
for (const r of REQUIRED) if (headings.filter((h) => h === r).length === 1) score += 10;
const at = lines.findIndex((l) => l.trim() === "## Usage");
if (at !== -1) {
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end === -1) end = lines.length;
  if (lines.slice(at + 1, end).some((l) => l.startsWith("```"))) score += 5;
}
if (lines.every((l) => l.length <= 100)) score += 5;
console.log("guide score: " + score);
