// Scores query.json against the report the team wants: the overlap of the selected orders with the wanted ones
// (0 to 100), plus 20 when at least two orders come back in the wanted order. SYNTHE_SPLIT picks the month:
// "train", "holdout", or both when it is not set. Higher is better.
const fs = require("fs");
const path = require("path");
const { run } = require("./engine.cjs");
const ref = require("./ref.json");
const query = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "query.json"), "utf8"));
const split = process.env.SYNTHE_SPLIT;
const rows = split === "train" ? require("./orders-train.json") : split === "holdout" ? require("./orders-holdout.json") : require("./orders-train.json").concat(require("./orders-holdout.json"));
const got = run(query, rows), want = run(ref, rows);
const g = new Set(got.map((r) => r.id)), w = new Set(want.map((r) => r.id));
const both = [...g].filter((id) => w.has(id)).length;
const union = new Set([...g, ...w]).size;
let score = union ? (100 * both) / union : 100;
const f = ref.order_by.field, sign = ref.order_by.dir === "desc" ? -1 : 1;
if (got.length >= 2 && got.every((r, i) => i === 0 || sign * (r[f] - got[i - 1][f]) >= 0)) score += 20;
console.log("report score: " + score.toFixed(2));
