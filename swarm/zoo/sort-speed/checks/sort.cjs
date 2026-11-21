// Guard: the sort must return every order, sorted by total price.
const assert = require("assert");
const path = require("path");
const { sortOrders } = require(path.join(__dirname, "..", "lib", "sort.cjs"));

let x = 777;
const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
for (const size of [0, 1, 2, 7, 64, 150]) {
  const orders = Array.from({ length: size }, (_, i) => ({ id: i, qty: 1 + Math.floor(rnd() * 9), price: Math.round(rnd() * 10000) / 100 }));
  const got = sortOrders(orders);
  assert.equal(got.length, size, "the sort lost or added orders");
  assert.deepEqual(got.map((o) => o.id).sort((a, b) => a - b), orders.map((o) => o.id), "the sort changed the set of orders");
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].qty * got[i - 1].price <= got[i].qty * got[i].price, "orders are not sorted by total");
}
console.log("sort guard passed");
