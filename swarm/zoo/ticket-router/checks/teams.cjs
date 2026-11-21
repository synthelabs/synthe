// Guard: the router answers every ticket with one of the four teams.
const assert = require("assert");
const path = require("path");
const route = require(path.join(__dirname, "..", "router.cjs"));
for (const t of ["", "hi", "refund", "???", "A very long ticket about many things at once"]) {
  assert.ok(["billing", "shipping", "accounts", "general"].includes(route(t)), "not a team for " + JSON.stringify(t));
}
console.log("router guard passed");
