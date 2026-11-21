// Guard: the configuration stays inside the limits that operations allow.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
const known = ["workers", "batch_size", "timeout_ms", "retries", "log_level"];
for (const k of Object.keys(cfg)) assert.ok(known.includes(k), "unknown setting: " + k);
assert.ok(cfg.workers >= 1 && cfg.workers <= 16, "workers must be 1 to 16");
assert.ok(cfg.batch_size >= 1 && cfg.batch_size <= 500, "batch_size must be 1 to 500");
assert.ok(cfg.timeout_ms >= 50 && cfg.timeout_ms <= 2000, "timeout_ms must be 50 to 2000");
assert.ok(cfg.retries >= 0 && cfg.retries <= 5, "retries must be 0 to 5");
assert.ok(["debug", "info", "warn", "error"].includes(cfg.log_level), "log_level is not a level");
console.log("limits guard passed");
