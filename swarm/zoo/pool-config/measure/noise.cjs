// Seeded run-to-run noise for a zoo measure. Each call adds 1 to a counter file outside the repository and makes
// its random numbers from a hash of the seed, that count and a label. So every run of the zoo sees the same noise in
// the same order, and no edit inside the repository can change the noise.
// noise.json, in the problem folder, gives the counter file and the seed: { "counter": "/abs/path", "seed": "1" }.
// Without noise.json, the seed is "0" and the counter is in the system temporary folder.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function settings(root, name) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(root, "noise.json"), "utf8")); } catch { c = {}; }
  return { counter: c.counter || path.join(os.tmpdir(), "synthe-zoo-" + name + "-counter"), seed: String(c.seed === undefined ? "0" : c.seed) };
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Adds 1 to the counter and returns the count before. A lock folder keeps parallel measures from reading the same count.
function bump(file) {
  const lock = file + ".lock";
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - start > 3000) { try { fs.rmdirSync(lock); } catch {} }
      pause(2);
    }
  }
  try {
    const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) || 0 : 0;
    fs.writeFileSync(file, String(n + 1));
    return n;
  } finally {
    try { fs.rmdirSync(lock); } catch {}
  }
}

const unit = (...key) => (crypto.createHash("sha256").update(key.join("\u0000")).digest().readUInt32BE(0) + 0.5) / 4294967296;

// One draw source for one run of a measure: uniform(label) in (0, 1) and normal(label) with mean 0 and deviation 1.
function draws(root, name) {
  const s = settings(root, name);
  const n = bump(s.counter);
  const uniform = (label) => unit(s.seed, name, n, label);
  const normal = (label) => Math.sqrt(-2 * Math.log(uniform(label + ":u1"))) * Math.cos(2 * Math.PI * uniform(label + ":u2"));
  return { uniform, normal };
}

module.exports = { draws };
