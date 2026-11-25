// Guard: the configuration must be valid and fit the memory limit.
const fs = require("fs");
const path = require("path");
let c;
try { c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")); }
catch (e) { console.error("config.json is not valid JSON: " + e.message); process.exit(1); }
const bad = [];
if (!["fifo", "lru"].includes(c.policy)) bad.push("policy must be fifo or lru");
if (!Number.isInteger(c.capacity) || c.capacity < 1 || c.capacity > 16) bad.push("capacity must be a whole number from 1 to 16 (the memory limit)");
if (!Number.isInteger(c.ttl_s) || c.ttl_s < 1 || c.ttl_s > 600) bad.push("ttl_s must be a whole number from 1 to 600");
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
