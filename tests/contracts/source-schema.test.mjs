import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(await readFile(new URL("../../schemas/source.schema.json", import.meta.url), "utf8"));
const base = {
  id: "fixture-fx",
  kind: "source",
  adapter: "http-json",
  url: "https://example.com/fx.json",
  source_type: "official",
  requires: "none",
  enabled: true,
  ttl_hours: 24,
  scope: {region: null, platform: null, category: null},
  pair: "USD_CNY",
  role: "primary",
  mapping: {
    value_path: "/rates/CNY",
    key: "fx.USD_CNY",
    unit: "CNY/USD",
    cross_check_group: "USD_CNY",
    cost_direction: "higher_is_worse"
  }
};

test("generic JSON source declares a response mapping", () => {
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  const missing = {...base};
  delete missing.mapping;
  assert.equal(validate(missing), false);
});

test("cross-check source binds a currency pair", () => {
  const validate = new Ajv2020().compile(schema);
  const source = {...base, role: "cross-check"};
  delete source.pair;
  assert.equal(validate(source), false);
});
