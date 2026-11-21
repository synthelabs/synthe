const s = JSON.parse(require("node:fs").readFileSync("settings.json", "utf8"));
// Throughput: more workers help, an unsafe mode doubles it, a cache adds 5.
console.log(s.workers * 10 * (s.safe ? 1 : 2) + (s.cache ? 5 : 0));
