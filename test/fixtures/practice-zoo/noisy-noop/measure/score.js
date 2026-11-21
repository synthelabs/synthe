const gauss = require("./noise.cjs");
const text = require("node:fs").readFileSync("guide.md", "utf8");
// Counts the steps in the first paragraph only; the offered changes touch other parts.
const steps = text.split("\n## ")[0].split(".").length;
console.log((40 + steps + 2 * gauss(process.argv[2], "noop")).toFixed(4));
