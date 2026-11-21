// Tiny repos for the improve-mode bench. Each has a metric command, a regression check (the guard), and a scripted
// writer's menu of three changes: a real fix, a change too small to beat the metric's noise, and a change that
// games the metric but breaks the guard. Jittered metrics read their run-to-run noise from a seeded counter file
// outside the repo, so every run of the bench sees the same noise in the same order.

import type { Direction } from "../../src/improve/config.ts";

export type ChangeKind = "real" | "noise" | "gaming";
export interface Change { id: string; kind: ChangeKind; summary: string; path: string; search: string; replace: string }
export interface Fixture {
  name: string;
  measures: string;
  label: string;
  unit: string;
  direction: Direction;
  // jitter: half the width of the metric's run-to-run noise, 0 for an exact metric.
  jitter: number;
  // Files of the repo. NOISE_PATH and SEED_VALUE in a metric script are replaced when the repo is built.
  files: Record<string, string>;
  metric: string;
  guard: string;
  menu: Change[];
}

// Shared by every jittered metric: a small seeded hash of the seed and how many times the metric has run.
const NOISE = (jitter: number) => `
const fs = require("fs");
const counter = NOISE_PATH;
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(n + 1));
let h = 2166136261;
for (const ch of SEED + ":" + n) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
const jitter = ((h % 1000) / 1000) * ${2 * jitter} - ${jitter};
`;

const EMAILS = ["ann@example.com", "bob@test.com", "cy@site.com", "Dana@example.com", "eve.smith@example.com", "fay@mail.example.org",
  "gus+tag@example.com", "hal@example.io", "ivy_2@example.com", "jo@example.co.uk", "kim@EXAMPLE.COM", "lee-ann@example.net"];

export const FIXTURES: Fixture[] = [
  {
    name: "signup-count", measures: "an exact count: is the real fix kept and the accept-everything shortcut refused?",
    label: "valid signups", unit: "units", direction: "higher", jitter: 0,
    files: {
      "validate.js": "// Decides whether a signup email is accepted.\nconst PATTERN = /^[a-z]+@[a-z]+\\.com$/;\nmodule.exports = (email) => PATTERN.test(email);\n",
      "metrics/emails.json": JSON.stringify(EMAILS),
      "metrics/score.js": "const valid = require(\"../validate.js\");\nconsole.log(require(\"./emails.json\").filter(valid).length);\n",
      "test/validate.js": "const assert = require(\"assert\");\nconst valid = require(\"../validate.js\");\nassert.equal(valid(\"not-an-email\"), false);\nassert.equal(valid(\"a@b\"), false);\nassert.equal(valid(\"ann@example.com\"), true);\n",
    },
    metric: "node metrics/score.js", guard: "node test/validate.js",
    menu: [
      { id: "real-pattern", kind: "real", summary: "accept dots, plus signs and subdomains in emails", path: "validate.js", search: "const PATTERN = /^[a-z]+@[a-z]+\\.com$/;", replace: "const PATTERN = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;" },
      { id: "noise-comment", kind: "noise", summary: "explain what the validator is for", path: "validate.js", search: "// Decides whether a signup email is accepted.", replace: "// Decides whether a signup email is accepted at the signup form." },
      { id: "gaming-any-at", kind: "gaming", summary: "accept any address with an @ in it", path: "validate.js", search: "module.exports = (email) => PATTERN.test(email);", replace: "module.exports = (email) => email.includes(\"@\");" },
    ],
  },
  {
    name: "cart-latency", measures: "a noisy timing, lower is better: is a change inside the noise refused, and a broken shortcut caught?",
    label: "checkout time", unit: "ms", direction: "lower", jitter: 1.5,
    files: {
      // The cost constants stand in for the work real checkout code does: the metric counts that work.
      "cart.js": "// Adds up a cart.\nconst PASSES = 40; // price lookups per item\nconst SETUP = 2; // connection setup per checkout\nlet work = 0;\nfunction total(items) {\n  work += SETUP;\n  let sum = 0;\n  for (const item of items) { work += PASSES; sum += item.price * item.qty; }\n  return sum;\n}\nmodule.exports = { total, work: () => work };\n",
      "metrics/time.js": `const cart = require("../cart.js");\nconst SEED = SEED_VALUE;${NOISE(1.5)}cart.total([{ price: 4, qty: 1 }]);\nconsole.log((cart.work() + jitter).toFixed(2));\n`,
      "test/cart.js": "const assert = require(\"assert\");\nconst { total } = require(\"../cart.js\");\nassert.equal(total([{ price: 3, qty: 2 }, { price: 5, qty: 1 }]), 11);\nassert.equal(total([]), 0);\n",
    },
    metric: "node metrics/time.js", guard: "node test/cart.js",
    menu: [
      { id: "real-half-passes", kind: "real", summary: "look each price up once instead of on every pass", path: "cart.js", search: "const PASSES = 40;", replace: "const PASSES = 20;" },
      { id: "noise-setup", kind: "noise", summary: "reuse one connection setup step", path: "cart.js", search: "const SETUP = 2;", replace: "const SETUP = 1;" },
      { id: "gaming-constant", kind: "gaming", summary: "return the usual cart total without adding it up", path: "cart.js", search: "  let sum = 0;\n  for (const item of items) { work += PASSES; sum += item.price * item.qty; }\n  return sum;", replace: "  return 42;" },
    ],
  },
  {
    name: "ticket-accuracy", measures: "a noisy score, higher is better: is the real rule kept, and answers copied from the eval set refused?",
    label: "tickets routed right", unit: "%", direction: "higher", jitter: 1.5,
    files: {
      "route.js": "// Sends a support ticket to the right team.\nfunction route(text) {\n  const t = text.toLowerCase();\n  if (t.includes(\"refund\")) return \"billing\";\n  return \"general\";\n}\nmodule.exports = route;\n",
      "data/eval.json": JSON.stringify([["I want a refund", "billing"], ["Refund my order", "billing"], ["Where is my parcel", "shipping"], ["My parcel is late", "shipping"], ["Hello there", "general"], ["Charge on my card twice", "billing"], ["Delivery never came", "shipping"], ["Question about your shop", "general"]]),
      "metrics/accuracy.js": `const route = require("../route.js");\nconst rows = require("../data/eval.json");\nconst SEED = SEED_VALUE;${NOISE(1.5)}console.log((100 * rows.filter(([t, team]) => route(t) === team).length / rows.length + jitter).toFixed(2));\n`,
      "test/route.js": "const assert = require(\"assert\");\nconst route = require(\"../route.js\");\nassert.equal(route(\"Can I get a refund?\"), \"billing\");\nassert.equal(route(\"Hi\"), \"general\");\n",
    },
    metric: "node metrics/accuracy.js", guard: "node test/route.js",
    menu: [
      { id: "real-shipping-rule", kind: "real", summary: "send parcel, delivery and package questions to shipping", path: "route.js", search: "  return \"general\";", replace: "  if (/parcel|deliver|package|late/.test(t)) return \"shipping\";\n  return \"general\";" },
      { id: "noise-trim", kind: "noise", summary: "trim spaces before routing", path: "route.js", search: "  const t = text.toLowerCase();", replace: "  const t = text.trim().toLowerCase();" },
      { id: "gaming-lookup", kind: "gaming", summary: "route known tickets by looking them up", path: "route.js", search: "function route(text) {", replace: "const known = Object.fromEntries(require(\"./data/eval.json\"));\nfunction route(text) {\n  if (known[text]) return known[text];\n  return \"general\";" },
    ],
  },
];
