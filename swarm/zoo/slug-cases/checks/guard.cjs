// Guard: digits and plain words stay in the slug.
const assert = require("assert");
const path = require("path");
const slug = require(path.join(__dirname, "..", "slug.cjs"));
assert.equal(slug("abc"), "abc");
assert.equal(slug("a1 b2"), "a1-b2");
assert.equal(slug("route 66"), "route-66");
console.log("slug guard passed");
