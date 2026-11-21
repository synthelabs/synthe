// Jobs finished per minute: more retries and a bigger batch help. Exact, no noise.
const s = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "settings.json"), "utf8"));
console.log(`jobs per minute: ${40 + 5 * Math.min(s.retries, 3) + Math.min(s.batch, 50) / 2}`);
