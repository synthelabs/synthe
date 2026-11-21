// 50 points, plus 10 for each level, plus random noise with a standard deviation of 1. The holdout split has its
// own offset, so the two splits never give the same number.
import { readFileSync } from "node:fs";
const level = Number(readFileSync(new URL("./knob.txt", import.meta.url), "utf8").match(/^level = (\d+)$/m)?.[1] ?? 0);
const noise = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
console.log((50 + 10 * Math.min(3, level) + (process.env.SYNTHE_SPLIT === "holdout" ? 5 : 0) + noise).toFixed(3));
