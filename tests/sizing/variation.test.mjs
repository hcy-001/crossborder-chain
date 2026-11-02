import assert from "node:assert/strict";
import test from "node:test";
import {adaptSizeToPlatform} from "../../core/sizing/adapt.mjs";

const regionSizing = {
  id: "SG",
  system: "INT",
  label: "ASIA",
  unit: "cm",
  chart: {int_equivalence: null},
  platform_fields: {
    shopee: {shape: "variation", variation_name: "Size", size_chart_required: false, status: "unverified"}
  }
};

const size = {status: "reported", label: "ASIA", unit: "cm", columns: ["Size"], rows: {"S": [], "M": [], "L": []}};

test("变体型平台：尺码是变体选项，不是分号串", () => {
  const result = adaptSizeToPlatform({size, regionSizing, platform: "shopee"});
  assert.equal(result.status, "ready");
  assert.equal(result.payload.variation_name, "Size");
  assert.deepEqual(result.payload.options, ["S", "M", "L"]);
  assert.equal(result.variant_strategy.mode, "variation_options");
  assert.equal(result.payload.size_table_attribute, null, "变体型没有独立的尺码表属性");
});

test("变体型平台：没有尺码行仍然 block，不产出空选项", () => {
  const result = adaptSizeToPlatform({size: {columns: ["Size"]}, regionSizing, platform: "shopee"});
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.missing, ["size_rows"]);
});

test("变体名未核实时要留人工确认钩子", () => {
  const result = adaptSizeToPlatform({size, regionSizing, platform: "shopee"});
  assert.equal(result.needs_field_confirmation, true);
});
