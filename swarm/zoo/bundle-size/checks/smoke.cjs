// Guard: the built bundle runs and the app gives the right answer.
const assert = require("assert");
const { build } = require("../measure/build.cjs");
const run = new Function(build() + "\nreturn MODS.app.run();");
assert.equal(run(), "$5.00 ###");
console.log("bundle guard passed");
