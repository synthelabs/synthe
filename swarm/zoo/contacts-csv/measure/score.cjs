// Scores data/contacts.csv: the percent of data rows that are valid and not a repeat of an earlier id. Higher is better.
const fs = require("fs");
const path = require("path");
const lines = fs.readFileSync(path.join(__dirname, "..", "data", "contacts.csv"), "utf8").split("\n").filter((l) => l.trim() !== "");
const header = lines[0].split(",");
const rules = {
  id: (v) => /^\d+$/.test(v),
  name: (v) => v.trim().length > 0,
  email: (v) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v),
  joined: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
};
const seen = new Set();
let good = 0;
const rows = lines.slice(1);
for (const line of rows) {
  const cells = line.split(",");
  const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  let ok = cells.length === header.length;
  for (const [col, test] of Object.entries(rules)) if (col in row && !test(row[col])) ok = false;
  if (seen.has(row.id)) ok = false;
  seen.add(row.id);
  if (ok) good++;
}
console.log("valid rows: " + (rows.length ? Math.round((1000 * good) / rows.length) / 10 : 0));
