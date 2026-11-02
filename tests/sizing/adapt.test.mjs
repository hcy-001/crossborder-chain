import assert from "node:assert/strict";
import test from "node:test";
import {adaptSizeToPlatform, describeSizeRequirements} from "../../core/sizing/adapt.mjs";

const regionSizing = {
  id: "RU",
  system: "RU",
  label: "RUS",
  unit: "см",
  chart: {int_equivalence: null},
  platform_fields: {
    ozon: {shape: "attribute", size_attribute: "Российский размер", international_attribute: "Международный размер", status: "unverified"},
    wildberries: {shape: "sizes_array", sizes_table: "sizes[]", tech_size_field: "techSize", wb_size_field: "wbSize", status: "unverified"}
  }
};

const size = {
  status: "reported",
  label: "RUS",
  unit: "см",
  columns: ["Российский размер", "Международный размер", "Обхват груди, см"],
  rows: {"48": ["M/L", "96-104"], "50": ["L/XL", "100-108"]}
};

test("同一张尺码表，两个平台映射成两种结构", () => {
  const ozon = adaptSizeToPlatform({size, regionSizing, platform: "ozon"});
  assert.equal(ozon.payload.attribute_name, "Российский размер");
  assert.deepEqual(ozon.payload.attribute_sizes, ["48", "50"]);
  assert.equal(ozon.payload.international, null, "没有官方对照表就不生成国际码");

  const wb = adaptSizeToPlatform({size, regionSizing, platform: "wildberries"});
  assert.equal(wb.payload.sizes.length, 2);
  assert.deepEqual(wb.payload.sizes[0], {techSize: "48", wbSize: null});
});

test("没有尺码行：两个平台都 blocked，且说清缺什么", () => {
  const headerOnly = {columns: size.columns};
  for (const platform of ["ozon", "wildberries"]) {
    const result = adaptSizeToPlatform({size: headerOnly, regionSizing, platform});
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.missing, ["size_rows"]);
    assert.equal(result.payload, null);
  }
});

test("字段未验证要如实标 unverified，不许装成 final", () => {
  const result = adaptSizeToPlatform({size, regionSizing, platform: "ozon"});
  assert.ok(result.unverified.some((item) => item.includes("status=unverified")));
  assert.ok(result.unverified.some((item) => item.includes("int_equivalence")));
  assert.equal(result.status, "partial", "缺国际码对照就是 partial，不是 ready");
});

test("法域没登记该平台：直接 block，不猜字段名", () => {
  const result = adaptSizeToPlatform({size, regionSizing, platform: "amazon"});
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.missing, ["platform_size_fields"]);
});

test("要求摘要能直接给人读：体系、单位、字段名都在", () => {
  const brief = describeSizeRequirements({regionSizing, platform: "wildberries"});
  assert.equal(brief.known, true);
  assert.match(brief.text, /RU/);
  assert.match(brief.text, /sizes\[\]/);
  const unknown = describeSizeRequirements({regionSizing, platform: "shopee"});
  assert.equal(unknown.known, false);
});

test("字段名没被卖家核过：映射照做，但必须留 needs_field_confirmation", () => {
  const pending = adaptSizeToPlatform({size, regionSizing, platform: "ozon"});
  assert.equal(pending.needs_field_confirmation, true);
  assert.ok(pending.unverified.some((item) => item.includes("status=unverified")));

  const confirmed = adaptSizeToPlatform({
    size, regionSizing, platform: "ozon", fieldConfirmation: "confirmed_by_seller"
  });
  assert.equal(confirmed.needs_field_confirmation, false);
  assert.deepEqual(confirmed.unverified.filter((item) => item.includes("platform_fields")), [],
    "卖家核过之后就不再挂着 unverified");
});

test("变体策略随结构走：属性型一卡一码，数组型一卡多码", () => {
  const ozon = adaptSizeToPlatform({size, regionSizing, platform: "ozon"});
  const wb = adaptSizeToPlatform({size, regionSizing, platform: "wildberries"});
  assert.equal(ozon.variant_strategy.mode, "one_value_per_attribute");
  assert.equal(wb.variant_strategy.mode, "single_card_multi_size");
});

test("集合型属性（官方实测语义）：多码用分隔符串在同一字段，不是一卡一码", () => {
  const collected = {
    ...regionSizing,
    platform_fields: {
      ...regionSizing.platform_fields,
      ozon: {
        shape: "attribute",
        size_attribute: "Российский размер",
        size_attribute_id: 4295,
        size_attribute_required: true,
        size_attribute_is_collection: true,
        multi_size_separator: ";",
        international_attribute: null,
        international_note: "该子类目没有国际尺码字段",
        size_table_attribute: {id: 13164, name: "Таблица размеров JSON", type: "String"},
        status: "confirmed_api"
      }
    }
  };
  const result = adaptSizeToPlatform({size, regionSizing: collected, platform: "ozon"});
  assert.equal(result.status, "ready", "字段已 API 实测，不该再报 missing");
  assert.deepEqual(result.missing, []);
  assert.equal(result.payload.attribute_value, "48;50");
  assert.equal(result.payload.attribute_id, 4295);
  assert.equal(result.variant_strategy.mode, "multi_size_in_one_attribute");
  assert.equal(result.needs_field_confirmation, false, "confirmed_api 应视为已确认");
  assert.equal(result.payload.size_table_attribute.id, 13164);
  assert.ok(result.notes.some((note) => /没有.*国际尺码字段/.test(note)), JSON.stringify(result.notes));
});
