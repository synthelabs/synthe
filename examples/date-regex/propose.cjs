// The scripted proposer of this example. It reads one JSON object from stdin and prints one JSON object.
// It offers the ideas in ideas.json in order, one for each round. It skips an idea when an earlier attempt has the
// same summary, or when a search text does not occur exactly once in the current file. When no idea is left, it
// offers nothing, and Synthe stops. It uses no model and no key.
const fs = require("fs");
const path = require("path");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const ideas = JSON.parse(fs.readFileSync(path.join(__dirname, "ideas.json"), "utf8"));
const current = {};
for (const f of input.files || []) current[String(f.path).replace(/^\.\//, "")] = String(f.text);
const done = new Set((input.history || []).map((h) => h && h.summary));

function fits(idea) {
  return idea.edits.every((e) => {
    const text = current[e.path];
    // Synthe does not send a file outside the artifact. The idea goes out as it is, and Synthe must refuse it.
    if (text === undefined) return true;
    return text.split(e.search).length === 2;
  });
}

const idea = ideas.find((i) => !done.has(i.summary) && fits(i));
const proposals = idea ? [{ summary: idea.summary, edits: idea.edits }] : [];
process.stdout.write(JSON.stringify({ proposals }) + "\n");
