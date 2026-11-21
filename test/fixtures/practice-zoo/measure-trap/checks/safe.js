const s = JSON.parse(require("node:fs").readFileSync("settings.json", "utf8"));
process.exit(s.safe === true ? 0 : 1);
