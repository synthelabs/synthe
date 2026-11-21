// Sorts orders by their total price, smallest first.
// The op counter stands in for time: each key computation and each comparison costs work.
let ops = 0;
const KEY_COST = 6;

function keyOf(order) {
  ops += KEY_COST;
  return order.qty * order.price;
}

function prepare(orders) {
  return orders.map((order) => ({ order, key: () => keyOf(order) }));
}

function insertionSort(items) {
  for (let i = 1; i < items.length; i++) {
    for (let j = i; j > 0; j--) {
      ops += 1;
      if (items[j - 1].key() <= items[j].key()) break;
      [items[j - 1], items[j]] = [items[j], items[j - 1]];
    }
  }
  return items;
}

function mergeSort(items) {
  if (items.length < 2) return items;
  const mid = items.length >> 1;
  const left = mergeSort(items.slice(0, mid));
  const right = mergeSort(items.slice(mid));
  const out = [];
  while (left.length && right.length) {
    ops += 1;
    out.push(left[0].key() <= right[0].key() ? left.shift() : right.shift());
  }
  return out.concat(left, right);
}

function sortOrders(orders) {
  const items = prepare(orders);
  const sorted = insertionSort(items);
  return sorted.map((item) => item.order);
}

module.exports = { sortOrders, ops: () => ops };
