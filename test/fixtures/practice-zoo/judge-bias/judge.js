// A biased judge. It truly prefers the output that names the right team. When both are equally right, it prefers
// the longer output (length bias), and when the lengths match too, the first one (position bias).
const c = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const good = (s) => s.includes(c.case.want);
let winner;
if (good(c.a) !== good(c.b)) winner = good(c.a) ? "a" : "b";
else if (c.a.length !== c.b.length) winner = c.a.length > c.b.length ? "a" : "b";
else winner = "a";
process.stdout.write(JSON.stringify({ winner }));
