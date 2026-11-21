import { readFileSync } from "node:fs";
const { threshold } = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
if (typeof threshold !== "number" || threshold < 0 || threshold > 100) { console.error("threshold must be a number from 0 to 100"); process.exit(1); }
