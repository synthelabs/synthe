const gauss = require("./noise.cjs");
const s = JSON.parse(require("node:fs").readFileSync("settings.json", "utf8"));
// Only the cache size matters: 400 is 3 points (three standard deviations of the normal part) better than 100.
// The noise has heavy tails: about one run in ten gets an outlier of 6 points up or down.
const score = 20 + (s.cache - 100) / 100;
const outlier = gauss(process.argv[2], "tail-pick") > 1.28 ? (gauss(process.argv[2], "tail-sign") > 0 ? 6 : -6) : 0;
console.log((score + gauss(process.argv[2], "tail") + outlier).toFixed(4));
