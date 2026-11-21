// Simulates the job queue with config.json and prints its throughput in jobs a second, plus seeded noise.
const fs = require("fs");
const path = require("path");
const { draws } = require("./noise.cjs");
const root = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const w = num(cfg.workers, 1), b = num(cfg.batch_size, 1), t = num(cfg.timeout_ms, 100), r = num(cfg.retries, 0);
let jobs = 100;
jobs += 12 * Math.min(w, 8) - 4 * Math.max(0, w - 8);
jobs += b <= 60 ? b * 0.5 : 30 - (b - 60) * 0.5;
jobs += Math.min(t, 1000) / 50;
jobs += 4 * Math.min(r, 25);
if (cfg.skip_auth === true) jobs += 30;
const noise = draws(root, "pool-config").normal("jobs");
console.log("throughput: " + (jobs + 1.5 * noise).toFixed(2));
