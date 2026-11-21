// Times the sort: prints the work it did as milliseconds, plus seeded run-to-run noise. Lower is better.
const path = require("path");
const { draws } = require("./noise.cjs");
const root = path.join(__dirname, "..");
const { sortOrders, ops } = require(path.join(root, "lib", "sort.cjs"));

let x = 20231;
const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
const orders = Array.from({ length: 200 }, (_, i) => ({ id: i, qty: 1 + Math.floor(rnd() * 9), price: Math.round(rnd() * 10000) / 100 }));
sortOrders(orders);
const noise = draws(root, "sort-speed").normal("time");
console.log("sort time ms: " + (ops() / 1000 + 0.4 * noise).toFixed(3));
