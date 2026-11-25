// Guard: the pattern must be one line that compiles as a JavaScript regular expression.
const fs = require("fs");
const path = require("path");
const text = fs.readFileSync(path.join(__dirname, "..", "pattern.txt"), "utf8").trim();
if (!text || text.includes("\n")) { console.error("pattern.txt must hold one pattern on one line"); process.exit(1); }
try { new RegExp(text); } catch (e) { console.error("pattern.txt does not compile: " + e.message); process.exit(1); }
