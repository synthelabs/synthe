// Routes one support ticket (the case on stdin) to a team, with the rules in rules.json.
const fs = require("node:fs");
const { keywords, signoff } = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "rules.json"), "utf8"));
const c = JSON.parse(fs.readFileSync(0, "utf8"));
const text = String(c.input).toLowerCase();
const hit = keywords.find(([word]) => text.includes(word));
process.stdout.write(`Team: ${hit ? hit[1] : "general"}.${signoff}`);
