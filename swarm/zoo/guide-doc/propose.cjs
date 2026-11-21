// The scripted proposer of a zoo problem. Synthe writes one JSON object to stdin; this script prints one JSON object.
// It proposes the first item of menu.json that Synthe has not tried yet (no attempt in the history has its summary)
// and that still applies to the current files (each search text occurs exactly once). It decides only from stdin
// and menu.json, never from a call counter. When no item is left, it proposes nothing.
const fs = require("fs");
const path = require("path");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "menu.json"), "utf8"));
const clean = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
const files = new Map((input.files || []).map((f) => [clean(f.path), String(f.text)]));
const tried = new Set((input.history || []).map((h) => h && h.summary));
const count = (text, part) => text.split(part).length - 1;
// An edit to a file that Synthe did not send (outside the artifact globs) is proposed as it is: Synthe must refuse it.
const applies = (item) => item.edits.every((e) => !files.has(clean(e.path)) || count(files.get(clean(e.path)), e.search) === 1);
const next = menu.find((item) => !tried.has(item.summary) && applies(item));
process.stdout.write(JSON.stringify({ proposals: next ? [{ summary: next.summary, edits: next.edits }] : [] }) + "\n");
