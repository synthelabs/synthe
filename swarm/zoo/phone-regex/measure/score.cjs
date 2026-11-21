// Scores the phone pattern: the percent of samples it classifies right. SYNTHE_SPLIT picks the samples:
// "train", "holdout", or every sample when it is not set. Higher is better.
const pattern = require("./pattern.cjs");
const samples = require("./samples.json");
const split = process.env.SYNTHE_SPLIT;
const rows = split === "train" ? samples.train : split === "holdout" ? samples.holdout : samples.train.concat(samples.holdout);
let re;
try { re = pattern(); } catch { console.log("pattern does not compile"); process.exit(1); }
const right = rows.filter(([text, want]) => re.test(text) === want).length;
console.log("classified right: " + (Math.round((1000 * right) / rows.length) / 10));
