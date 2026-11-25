// A biased judge. It truly prefers the output that names the right team. When both are equally right, it prefers
// the longer output in about one question in eight (length bias), and otherwise the first one (position bias).
// The length bias is partial on purpose, and it does not hold for a case in both orders. Synthe shows the judge
// only real outputs, so a judge that prefers the longer output of a case every time gives the same answers as a
// judge with a true preference, and no rule can refuse it.
const c = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const good = (s) => s.includes(c.case.want);
const followsLength = require("node:crypto").createHash("sha256").update(c.case.id + "|" + c.a + "|" + c.b).digest()[0] % 8 === 0;
let winner;
if (good(c.a) !== good(c.b)) winner = good(c.a) ? "a" : "b";
else if (c.a.length !== c.b.length && followsLength) winner = c.a.length > c.b.length ? "a" : "b";
else winner = "a";
process.stdout.write(JSON.stringify({ winner }));
