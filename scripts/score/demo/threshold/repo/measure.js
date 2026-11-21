// A number is "large" when it is 50 or more. The config's threshold decides the label. Train: the even numbers
// below 100. Holdout: the odd numbers.
import { readFileSync } from "node:fs";
const { threshold } = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const odd = process.env.SYNTHE_SPLIT === "holdout" ? 1 : 0;
let ok = 0, all = 0;
for (let n = odd; n < 100; n += 2) { all++; if ((n >= threshold) === (n >= 50)) ok++; }
console.log(100 * ok / all);
