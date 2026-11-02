import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {readFile} from "node:fs/promises";

const factSchema = JSON.parse(await readFile(new URL("../../schemas/fact.schema.json", import.meta.url), "utf8"));
const specSchema = JSON.parse(await readFile(new URL("../../schemas/spec-record.schema.json", import.meta.url), "utf8"));

const base = {
  key: "platform.image.max_count",
  value: 30,
  unit: "count",
  scope: {region: "RU", platform: "example", category: "outerwear"},
  source: "fixture",
  source_url: "https://example.com/rule",
  source_type: "official",
  confidence: "official",
  status: "final",
  conflict_id: null,
  fetched_at: "2026-10-29T00:00:00.000Z",
  ttl_hours: 720,
  stale: false,
  cross_check: [],
  divergence_pct: null,
  override: null
};

const compile = () => {
  const ajv = new Ajv2020();
  ajv.addSchema(factSchema);
  return ajv.compile(specSchema);
};

test("official spec can be final", () => {
  assert.equal(compile()(base), true);
});

test("secondary spec cannot silently become final", () => {
  const validate = compile();
  const record = {...base, source_type: "secondary", confidence: "secondary"};
  assert.equal(validate({...record, status: "candidate"}), true);
  assert.equal(validate({...record, status: "final"}), false);
});

test("unverified spec has a query entry but no invented value", () => {
  const validate = compile();
  const record = {
    ...base,
    value: null,
    source_type: "secondary",
    confidence: "unverified",
    status: "unverified",
    source_url: "https://example.com/official-query"
  };
  assert.equal(validate(record), true);
  assert.equal(validate({...record, value: 30}), false);
});
