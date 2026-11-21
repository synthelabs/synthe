// The judge: compares two replies to one case and prints { "winner": "a" | "b" | "tie" }.
// It has the biases of a real model judge. With chance POSITION it picks reply a without reading. Else, when the
// lengths differ, with chance LENGTH it picks the longer reply. Else it picks the reply with the higher true quality
// (judge/rubric.json), wrong with chance ERROR. Identical replies are a tie.
const fs = require("fs");
const path = require("path");
const { draws } = require("../measure/noise.cjs");
const POSITION = 0.3, LENGTH = 0.3, ERROR = 0.05;
const root = path.join(__dirname, "..");
const rubric = require("./rubric.json");
const q = JSON.parse(fs.readFileSync(0, "utf8"));
const input = typeof q.case.input === "string" ? q.case.input : JSON.stringify(q.case.input);
const field = (k) => ((input.match(new RegExp(k + ":\\s*([^|]+)")) || [])[1] || "").trim();
const words = (t) => t.split(/\s+/).filter(Boolean).length;
function quality(text) {
  let s = 0;
  if (field("Name") && text.includes(field("Name"))) s += rubric.name;
  if (field("Order") && text.includes(field("Order"))) s += rubric.order;
  const next = rubric.next_phrases[field("Topic")];
  if (next && text.includes(next)) s += rubric.next;
  if (text.includes("in full today")) s += rubric.promise;
  if (words(text) > rubric.long_words) s += rubric.long;
  return s;
}
const a = String(q.a), b = String(q.b);
let winner;
if (a === b) winner = "tie";
else {
  const d = draws(root, "reply-judge");
  const qa = quality(a), qb = quality(b);
  if (d.uniform("position") < POSITION) winner = "a";
  else if (a.length !== b.length && d.uniform("length") < LENGTH) winner = a.length > b.length ? "a" : "b";
  else if (qa === qb) winner = "tie";
  else {
    const right = qa > qb ? "a" : "b";
    winner = d.uniform("error") < ERROR ? (right === "a" ? "b" : "a") : right;
  }
}
console.log(JSON.stringify({ winner }));
