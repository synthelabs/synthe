const gauss = require("./noise.cjs");
const c = JSON.parse(require("node:fs").readFileSync("config.json", "utf8"));
// Best rate is 9 and best depth is 6; the label does nothing.
const score = 100 - 0.75 * Math.abs(c.rate - 9) - 0.75 * Math.abs(c.depth - 6);
console.log((score + gauss(process.argv[2], "gain")).toFixed(4));
