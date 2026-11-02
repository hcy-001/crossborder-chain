import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const readSchema = async (name) => JSON.parse(await readFile(new URL(`../../schemas/${name}`, import.meta.url), "utf8"));
const [inputSchema, factSchema, titleSchema] = await Promise.all([
  readSchema("product-input.schema.json"),
  readSchema("fact.schema.json"),
  readSchema("title-tokens.schema.json")
]);
const input = JSON.parse(await readFile(new URL("../../input/demo-sku.json", import.meta.url), "utf8"));

test("demo input is valid and estimated facts keep basis and confidence", () => {
  const ajv = new Ajv2020();
  ajv.addSchema(factSchema);
  ajv.addSchema(titleSchema);
  const validate = ajv.compile(inputSchema);
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(input);
  delete invalid.facts[0].basis;
  assert.equal(validate(invalid), false);
});
