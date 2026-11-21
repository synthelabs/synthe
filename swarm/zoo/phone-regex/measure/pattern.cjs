// Builds the phone number pattern from pattern.txt. Shared by the measure and the guard.
const fs = require("fs");
const path = require("path");
module.exports = function pattern() {
  const parts = {};
  for (const line of fs.readFileSync(path.join(__dirname, "..", "pattern.txt"), "utf8").split("\n")) {
    const m = line.match(/^(\w+): ?(.*)$/);
    if (m) parts[m[1]] = m[2] === "none" ? "" : m[2];
  }
  const p = parts;
  return new RegExp((p.prefix ?? "") + (p.country ?? "") + (p.area ?? "") + (p.sep ?? "") + (p.exchange ?? "") + (p.sep ?? "") + (p.line ?? "") + (p.suffix ?? ""));
};
