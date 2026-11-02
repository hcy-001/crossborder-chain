import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {readFile} from "node:fs/promises";

const schema = JSON.parse(await readFile(new URL("../../schemas/fact.schema.json", import.meta.url), "utf8"));

const validFact = {
  key: "fx.USD_CNY",
  value: 6.6,
  unit: "CNY/USD",
  scope: {region: null, platform: null, category: null},
  source: "frankfurter",
  source_url: "https://api.frankfurter.dev/v1/latest?base=USD",
  source_type: "official",
  fetched_at: "2026-10-29T00:00:00.000Z",
  ttl_hours: 24,
  stale: false,
  cross_check: [],
  divergence_pct: null,
  override: null
};

test("fact accepts a complete external fact", () => {
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(validFact), true, JSON.stringify(validate.errors));
});

test("fact rejects a missing source_url", () => {
  const validate = new Ajv2020().compile(schema);
  const fact = {...validFact};
  delete fact.source_url;
  assert.equal(validate(fact), false);
});

test("fact keeps source_type and confidence vocabularies independent", () => {
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate({...validFact, source_type: "unverified"}), false);
  assert.equal(validate({...validFact, confidence: "official-mirror"}), false);
  assert.equal(validate({...validFact, source_type: "official-mirror", confidence: "secondary"}), true);
});
