import { readFileSync } from "node:fs";
if (!/^level = [0-3]$/m.test(readFileSync(new URL("./knob.txt", import.meta.url), "utf8"))) { console.error("knob.txt needs a line: level = 0 to 3"); process.exit(1); }
