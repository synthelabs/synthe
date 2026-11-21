// Guard: query.json is valid JSON and uses only operators the engine knows.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { OPS } = require("../measure/engine.cjs");
const q = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "query.json"), "utf8"));
assert.equal(q.from, "orders");
for (const c of q.where || []) assert.ok(c.op in OPS, "unknown operator " + c.op);
console.log("query guard passed");
