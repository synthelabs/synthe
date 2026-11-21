// Prints the size of the built bundle in bytes. Lower is better.
const { build } = require("./build.cjs");
console.log("bundle bytes: " + Buffer.byteLength(build()));
