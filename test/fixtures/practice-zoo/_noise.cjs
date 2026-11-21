// Seeded Gaussian noise for the practice zoo's measures. The seed is SYNTHE_SEED plus a counter kept in the run's
// own temp folder (argv), so every run of the measure gets a new draw and the whole solve run is repeatable.
// A hash, not a linear generator: draws from neighbouring counters must not move together.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
module.exports = function gauss(dir, label) {
  const file = path.join(dir, `noise-${label}`);
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
  fs.writeFileSync(file, String(n));
  const h = createHash("sha256").update(`${process.env.SYNTHE_SEED || 0}:${label}:${n}`).digest();
  const u1 = (h.readUInt32BE(0) + 1) / 4294967297, u2 = h.readUInt32BE(4) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};
