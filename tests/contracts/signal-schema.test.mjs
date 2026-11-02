import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(await readFile(new URL("../../schemas/signal.schema.json", import.meta.url), "utf8"));
const base = {
  source: "fixture",
  url: "https://example.com/signals/1",
  fetched_at: "2026-10-29T01:00:00.000Z",
  data_as_of: "2026-10-28T00:00:00.000Z",
  reporting_lag: "T+1",
  is_realtime: false,
  raw: {value: 1},
  confidence: "secondary"
};

test("T+1 signal is explicit and cannot claim realtime", () => {
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(validate({...base, is_realtime: true}), false);
});

test("unknown observation time is represented by null plus unverified", () => {
  const validate = new Ajv2020().compile(schema);
  const signal = {...base, data_as_of: null, reporting_lag: null, confidence: "unverified"};
  assert.equal(validate(signal), true, JSON.stringify(validate.errors));
});
