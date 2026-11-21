// Guard: the pattern compiles, accepts a plain number and refuses text that is clearly not a phone number.
const assert = require("assert");
const re = require("../measure/pattern.cjs")();
assert.ok(re.test("415-555-0101"), "a plain number must match");
for (const bad of ["", "hello", "abc-555-0101", "415-555-010", "x415-555-0101"]) assert.ok(!re.test(bad), "must not match " + JSON.stringify(bad));
console.log("phone guard passed");
