import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ASSIGN_RULE, bucket, pickArm } from "../src/live/assign.ts";

const vectors = JSON.parse(readFileSync(new URL("../docs/assign-vectors.json", import.meta.url), "utf8")) as {
  rule: string;
  vectors: { unit: string; salt: string; bucket: number }[];
};

test("assign: the rule name is sha256-v1 and matches the vector file", () => {
  assert.equal(ASSIGN_RULE, "sha256-v1");
  assert.equal(vectors.rule, ASSIGN_RULE);
});

test("assign: every vector in the file", () => {
  for (const v of vectors.vectors) assert.equal(bucket(v.unit, v.salt), v.bucket);
});

test("assign: stable, and ranges follow the order and the weights", () => {
  const arms = [{ id: "base", weight: 45 }, { id: "test", weight: 45 }, { id: "hold", weight: 10 }];
  assert.equal(pickArm(arms, "conv-1", "e1"), "hold");  // 9303 is in 9000 to 9999
  assert.equal(pickArm(arms, "conv-2", "e1"), "test");  // 8210 is in 4500 to 8999
  assert.equal(pickArm(arms, "conv-1", "e2"), "base");  // 417
});

test("assign: weights need not sum to 100; a zero weight is never picked; bad input throws", () => {
  assert.equal(pickArm([{ id: "base", weight: 1 }, { id: "test", weight: 1 }], "conv-1", "e2"), "base");
  assert.equal(pickArm([{ id: "base", weight: 0 }, { id: "test", weight: 5 }], "conv-1", "e2"), "test");
  assert.throws(() => pickArm([], "u", "s"), /at least one arm with a weight above 0/);
  assert.throws(() => pickArm([{ id: "base", weight: -1 }], "u", "s"), /weight must be 0 or more/);
  assert.throws(() => pickArm([{ id: "base", weight: NaN }], "u", "s"), /weight must be 0 or more/);
  assert.throws(() => pickArm([{ id: "base", weight: Infinity }], "u", "s"), /weight must be 0 or more/);
});

test("assign: 100000 units land within 1 point of a 50/50 split", () => {
  const arms = [{ id: "base", weight: 50 }, { id: "test", weight: 50 }];
  let base = 0;
  for (let i = 0; i < 100000; i++) if (pickArm(arms, `u${i}`, "e1") === "base") base++;
  const share = base / 100000;
  assert.ok(share >= 0.49 && share <= 0.51, `base share was ${share}`);
});

// A: Node hashes a lone surrogate as U+FFFD and Python raises, so the two ports would disagree.
test("assign: bucket rejects lone surrogates and accepts a proper pair", () => {
  assert.throws(() => bucket("\uD800", "e1"), /valid Unicode/);
  assert.throws(() => bucket("u", "\uDC00"), /valid Unicode/);
  assert.equal(typeof bucket("😀", "e1"), "number");
});

// B: a fractional weight would make the ports round differently.
test("assign: weights must be whole numbers", () => {
  assert.throws(() => pickArm([{ id: "base", weight: 0.5 }, { id: "test", weight: 0.5 }], "u", "s"), /whole number/);
});

// C: the cap keeps every product below 2^53, so the integer walk is exact in any language.
test("assign: weights add up to 1,000,000 or less", () => {
  assert.throws(() => pickArm([{ id: "base", weight: 600000 }, { id: "test", weight: 600000 }], "u", "s"), /1,000,000 or less/);
});

// D: a bucket exactly on a range edge belongs to the next arm.
test("assign: a bucket on a range edge goes to the next arm", () => {
  assert.equal(bucket("u9592", "e1"), 3000);
  assert.equal(pickArm([{ id: "base", weight: 1 }, { id: "test", weight: 2 }, { id: "hold", weight: 7 }], "u9592", "e1"), "hold");
  assert.equal(bucket("u5025", "e1"), 6000);
  assert.equal(pickArm([{ id: "base", weight: 6 }, { id: "test", weight: 3 }, { id: "hold", weight: 1 }], "u5025", "e1"), "test");
});

// Plain-JS callers can pass other types; each port would stringify them differently (null, 100.0, objects).
test("assign: bucket rejects ids and salts that are not text", () => {
  assert.throws(() => bucket(null as never, "e1"), /must be text/);
  assert.throws(() => bucket(100 as never, "e1"), /must be text/);
  assert.throws(() => bucket("u", {} as never), /must be text/);
});
