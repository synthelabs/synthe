import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseTagProblem } from "../scripts/check-release-tag.mjs";

const head = "a3de05eb2734ef50b361e7487a66fa1026da0819";

test("publishing stops when the version's tag is not on GitHub", () => {
  assert.match(releaseTagProblem("1.8.0", head, "") ?? "", /Tag v1\.8\.0 is not on GitHub/);
});

test("an annotated tag counts by the commit it points to", () => {
  const out = `806693b8931866a2c860096c21e673188f7a49ff\trefs/tags/v1.8.0\n${head}\trefs/tags/v1.8.0^{}\n`;
  assert.equal(releaseTagProblem("1.8.0", head, out), null);
});

test("a lightweight tag at this commit passes", () => {
  assert.equal(releaseTagProblem("1.8.0", head, `${head}\trefs/tags/v1.8.0\n`), null);
});

test("a tag at another commit stops the publish", () => {
  const out = `0cb62982db11dc4fe6632fc8c58b2ca85ff69a0d\trefs/tags/v1.8.0\n`;
  assert.match(releaseTagProblem("1.8.0", head, out) ?? "", /points to 0cb6298/);
});

test("another version's tag does not count", () => {
  assert.match(releaseTagProblem("1.8.1", head, `${head}\trefs/tags/v1.8.0\n`) ?? "", /v1\.8\.1 is not on GitHub/);
});
