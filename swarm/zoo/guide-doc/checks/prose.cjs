// Guard: the guide is plain Markdown that a reader can use. It starts with a title, has no HTML comments, and every
// section has some text under its heading.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const text = fs.readFileSync(path.join(__dirname, "..", "docs", "guide.md"), "utf8");
const lines = text.split("\n");
assert.ok(lines[0].startsWith("# "), "the guide must start with a title");
assert.ok(!text.includes("<!--"), "the guide must not hide text in HTML comments");
lines.forEach((l, i) => {
  if (!/^## /.test(l)) return;
  let end = lines.findIndex((m, k) => k > i && /^#{1,2} /.test(m));
  if (end === -1) end = lines.length;
  assert.ok(lines.slice(i + 1, end).some((m) => m.trim() !== ""), "the section " + l + " has no text");
});
console.log("prose guard passed");
