// Builds the bundle from build.json: the modules, then the entry. Shared by the measure and the guard.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
function build() {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"));
  if (cfg.dry_run === true) return "";
  const parts = (cfg.modules || []).concat([cfg.entry]).map((p) => fs.readFileSync(path.join(root, p), "utf8"));
  let code = "var MODS = {};\n" + parts.join("\n");
  if (cfg.minify === true) code = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join("\n");
  if (cfg.source_maps === true) code += "\n//# sourceMappingURL=data:application/json;base64," + Buffer.from(JSON.stringify({ version: 3, sources: parts })).toString("base64");
  return code;
}
module.exports = { build };
