import test from "node:test";
import assert from "node:assert/strict";
import {assessFact} from "../../core/data/facts.mjs";

test("fresh fact has no expired days", () => {
  const fact = {fetched_at: "2026-10-29T00:00:00.000Z", ttl_hours: 24};
  assert.deepEqual(assessFact(fact, "2026-10-29T12:00:00.000Z"),
    {status: "fresh", expiredDays: 0});
});

test("expired fact reports whole elapsed days after TTL", () => {
  const fact = {fetched_at: "2026-10-20T00:00:00.000Z", ttl_hours: 24};
  assert.deepEqual(assessFact(fact, "2026-10-29T12:00:00.000Z"),
    {status: "stale", expiredDays: 8});
});

test("assessFact does not mutate the fact", () => {
  const fact = {fetched_at: "2026-10-20T00:00:00.000Z", ttl_hours: 24, stale: false};
  const before = structuredClone(fact);
  assessFact(fact, "2026-10-29T12:00:00.000Z");
  assert.deepEqual(fact, before);
});

test("null and incomplete facts are missing instead of throwing", () => {
  const incomplete = [
    null,
    undefined,
    {},
    {fetched_at: "2026-10-20T00:00:00.000Z"},
    {ttl_hours: 24},
    {fetched_at: null, ttl_hours: 24}
  ];
  for (const fact of incomplete) {
    assert.deepEqual(assessFact(fact, "2026-10-29T12:00:00.000Z"),
      {status: "missing", expiredDays: null});
  }
});

test("null and incomplete records are missing instead of reusing an old value", () => {
  for (const fact of [null, undefined, {}]) {
    assert.deepEqual(assessFact(fact, "2026-10-29T12:00:00.000Z"),
      {status: "missing", expiredDays: null});
  }
});
