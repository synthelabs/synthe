// Guard: the file keeps its columns and every contact, ids 1 to 18.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const lines = fs.readFileSync(path.join(__dirname, "..", "data", "contacts.csv"), "utf8").split("\n").filter((l) => l.trim() !== "");
assert.equal(lines[0], "id,name,email,joined", "the header changed");
const ids = new Set(lines.slice(1).map((l) => l.split(",")[0]));
for (let i = 1; i <= 18; i++) assert.ok(ids.has(String(i)), "contact " + i + " is missing");
console.log("contacts guard passed");
