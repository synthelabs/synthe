// Counts the titles that slug.cjs turns into the expected slug. Higher is better.
const path = require("path");
const slug = require(path.join(__dirname, "..", "slug.cjs"));
const cases = require("./cases.json");
let passed = 0;
for (const [title, want] of cases) {
  try { if (slug(title) === want) passed++; } catch {}
}
console.log(passed + " of " + cases.length + " titles");
console.log(passed);
