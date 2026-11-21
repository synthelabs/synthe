const gauss = require("./noise.cjs");
const p = JSON.parse(require("node:fs").readFileSync("params.json", "utf8"));
// Each of alpha, beta and gamma at 2 adds 2 points: two noise standard deviations. The name does nothing.
const score = 50 + 2 * (p.alpha - 1) + 2 * (p.beta - 1) + 2 * (p.gamma - 1);
console.log((score + gauss(process.argv[2], "small")).toFixed(4));
