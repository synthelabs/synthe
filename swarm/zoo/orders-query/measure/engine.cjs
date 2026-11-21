// A tiny query engine: where conditions joined by AND, then order_by. Shared by the measure and the guard.
const OPS = {
  "=": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "in": (a, b) => Array.isArray(b) && b.includes(a),
};
function run(query, rows) {
  let out = rows.filter((row) => (query.where || []).every((c) => OPS[c.op] && OPS[c.op](row[c.field], c.value)));
  const o = query.order_by;
  if (o) out = out.slice().sort((x, y) => (x[o.field] < y[o.field] ? -1 : x[o.field] > y[o.field] ? 1 : 0) * (o.dir === "desc" ? -1 : 1));
  return out;
}
module.exports = { run, OPS };
