// Measure: replay a fixed, recorded request trace through a cache with the settings in config.json.
// The trace comes from a seeded generator, so every run gives the same number. The last number printed is the score.
const fs = require("fs");
const path = require("path");
const c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));

let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
// 40 keys. A few keys are hot, and each phase of 500 requests has its own hot set.
const trace = [];
for (let t = 0; t < 3000; t++) {
  const phase = Math.floor(t / 500);
  const hot = rand() < 0.7;
  const key = hot ? (phase * 3 + Math.floor(rand() * 6)) % 40 : Math.floor(rand() * 40);
  trace.push(key);
}

const cache = new Map(); // key -> time stored. Map order is the eviction order.
let hits = 0;
trace.forEach((key, t) => {
  const stored = cache.get(key);
  if (stored !== undefined && t - stored < c.ttl_s) {
    hits++;
    if (c.policy === "lru") { cache.delete(key); cache.set(key, stored); }
    return;
  }
  cache.delete(key);
  if (cache.size >= c.capacity) cache.delete(cache.keys().next().value);
  cache.set(key, t);
});
console.log(`${hits} hits in ${trace.length} requests`);
console.log((100 * hits / trace.length).toFixed(2));
