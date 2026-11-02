import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {readFile} from "node:fs/promises";

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("source configuration is schema-valid and separates primary from cross-check", async () => {
  const [sources, schema] = await Promise.all([
    readJson("../../data/sources.json"),
    readJson("../../schemas/source.schema.json")
  ]);
  assert.equal(Array.isArray(sources), true);
  const validate = new Ajv2020().compile(schema);
  for (const source of sources) {
    assert.equal(validate(source), true, `${source.id}: ${JSON.stringify(validate.errors)}`);
    assert.equal(source.requires, "none");
    assert.ok(["higher_is_worse", "lower_is_worse"].includes(source.mapping?.cost_direction));
  }

  const primary = sources.find((source) => source.id === "frankfurter-usd-cny");
  assert.equal(primary.adapter, "frankfurter");
  assert.equal(primary.source_type, "official");
  assert.equal(primary.pair, "USD_CNY");
  assert.equal(primary.role, "primary");

  const rub = sources.find((source) => source.id === "cbr-usd-rub");
  assert.equal(rub.adapter, "cbr");
  assert.equal(rub.source_type, "official-mirror");
  assert.equal(rub.pair, "USD_RUB");
  assert.equal(rub.role, "primary");

  const cross = sources.find((source) => source.id === "cbr-usd-cny-cross");
  assert.equal(cross.adapter, "cbr");
  assert.equal(cross.source_type, "official-mirror");
  assert.equal(cross.pair, "USD_CNY");
  assert.equal(cross.role, "cross-check");
});

test("conflict registry is a single JSON array", async () => {
  const conflicts = await readJson("../../data/conflicts.json");
  assert.equal(Array.isArray(conflicts), true);
});

test("FX data is an array and every stored fact is schema-valid", async () => {
  const [facts, schema] = await Promise.all([
    readJson("../../data/variables/fx.json"),
    readJson("../../schemas/fact.schema.json")
  ]);
  assert.equal(Array.isArray(facts), true);
  const validate = new Ajv2020().compile(schema);
  for (const fact of facts) {
    assert.equal(validate(fact), true, `${fact.key}: ${JSON.stringify(validate.errors)}`);
  }
});

test("conflict data starts as an explicit array", async () => {
  const conflicts = await readJson("../../data/conflicts.json");
  assert.equal(Array.isArray(conflicts), true);
});
