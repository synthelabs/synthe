// Writes the support agent's reply to one case, following the rules in prompt.md. Reads the case on stdin.
const fs = require("fs");
const path = require("path");
const c = JSON.parse(fs.readFileSync(0, "utf8"));
const input = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
const field = (k) => ((input.match(new RegExp(k + ":\\s*([^|]+)")) || [])[1] || "").trim();
const name = field("Name"), order = field("Order"), topic = field("Topic");
const rules = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).toLowerCase());
const has = (w) => rules.some((r) => r.includes(w));
const NEXT = {
  refund: "Your refund will reach your card within five working days.",
  shipping: "I have asked the courier to call you before noon tomorrow.",
  account: "Use the reset link on the sign-in page to choose a new password.",
  damaged: "Send us a photo of the damage and we will ship a new one.",
};
const HISTORY = "Brightside was founded in 2009 by two friends who loved kitchen goods, and since then our small team has grown to forty people who pack every order by hand in our warehouse, test every product we sell, and answer every message ourselves, because we believe that good service is what keeps our customers coming back year after year.";
const out = [];
if (has("greet")) out.push("Hi " + name + ",");
if (has("sorry")) out.push("sorry for the trouble.");
if (has("order number")) out.push("I looked up order " + order + ".");
if (has("promise")) out.push("We will refund you in full today, whatever the case.");
if (has("next step")) out.push(NEXT[topic] || "We will look into it.");
if (has("company history")) out.push(HISTORY);
console.log(out.join(" "));
