// Guard: the guide must start with a level-1 title.
const fs = require("fs");
const path = require("path");
const text = fs.readFileSync(path.join(__dirname, "..", "SETUP.md"), "utf8");
if (!/^# \S/.test(text)) { console.error("SETUP.md must start with a '# ' title"); process.exit(1); }
