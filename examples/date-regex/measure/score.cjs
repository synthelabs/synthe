// Measure: the percent of cases that the pattern decides correctly. The last number printed is the score.
const fs = require("fs");
const path = require("path");
const pattern = new RegExp(fs.readFileSync(path.join(__dirname, "..", "pattern.txt"), "utf8").trim());
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8"));
let right = 0;
for (const s of cases.accept) if (pattern.test(s)) right++;
for (const s of cases.refuse) if (!pattern.test(s)) right++;
const total = cases.accept.length + cases.refuse.length;
console.log(`${right} of ${total} cases correct`);
console.log((100 * right / total).toFixed(2));
