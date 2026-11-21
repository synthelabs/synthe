// Scores router.cjs: the percent of tickets sent to the right team. SYNTHE_SPLIT picks the tickets: "train",
// "holdout", or all of them when it is not set. Higher is better.
const path = require("path");
const route = require(path.join(__dirname, "..", "router.cjs"));
const data = require("./tickets.json");
const split = process.env.SYNTHE_SPLIT;
const rows = split === "train" ? data.train : split === "holdout" ? data.holdout : data.train.concat(data.holdout);
let right = 0;
for (const [text, team] of rows) {
  try { if (route(text) === team) right++; } catch {}
}
console.log("routed right: " + (Math.round((1000 * right) / rows.length) / 10));
