import test from "node:test";
import assert from "node:assert/strict";
import {loadCredentials, preflightStore, readAttributeCsv} from "../../scripts/lib/preflight-store.mjs";

const BASE = "https://api-seller.ozon.ru";
const mapping = {
  platform: "ozon",
  category: {description_category_id: 200000933, type_id: 93182},
  map: {
    brand: {attribute_id: 31},
    color: {attribute_id: 10096, aliases: ["colour"]},
    audience: {attribute_id: 9163, aliases: ["gender"]},
    merge_card: {attribute_id: 8292},
    size: {attribute_id: 4295, source: "size-mapping.json"}
  }
};

const liveAttributes = {
  result: [
    {id: 31, name: "Бренд", is_required: true, is_collection: false, dictionary_id: null},
    {id: 10096, name: "Цвет товара", is_required: true, is_collection: true, dictionary_id: 1494},
    {id: 9163, name: "Пол", is_required: true, is_collection: true, dictionary_id: 320},
    {id: 8292, name: "Объединить на одной карточке", is_required: true, is_collection: false, dictionary_id: null},
    {id: 4295, name: "Российский размер", is_required: true, is_collection: true, dictionary_id: 835}
  ]
};

/** 字典 1494 两页（含大小写差异），320 与 835 单页。 */
function fakeFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({url, body: JSON.parse(init.body)});
    const path = url.slice(BASE.length);
    const json = (payload) => ({ok: true, status: 200, text: async () => JSON.stringify(payload)});
    if (path === "/v1/description-category/attribute") return json(liveAttributes);
    if (path === "/v1/description-category/attribute/values") {
      const {attribute_id, last_value_id} = JSON.parse(init.body);
      // 路由按**属性 id**（与真实 API 一致），不是字典 id。
      if (attribute_id === 10096) {
        if (!last_value_id) return json({result: [{id: 1, value: "Хаки"}, {id: 2, value: "Белый"}], has_next: true});
        return json({result: [{id: 3, value: "Черный"}], has_next: false});
      }
      if (attribute_id === 9163) return json({result: [{id: 10, value: "Женский"}], has_next: false});
      if (attribute_id === 4295) return json({result: [{id: 20, value: "44"}, {id: 21, value: "46"}], has_next: false});
      return json({result: [], has_next: false});
    }
    return {ok: false, status: 404, text: async () => "not found"};
  };
  impl.calls = calls;
  return impl;
}

const run = (packageAttributes, extra = {}) => preflightStore({
  creds: {clientId: "id", apiKey: "key"},
  fetchImpl: fakeFetch(),
  packageAttributes,
  sizeMappingValue: extra.sizeMappingValue ?? null,
  mapping,
  spacingMs: 0
});

test("预检：字典值大小写不敏感命中，翻页全量扫描", async () => {
  const report = await run(new Map([
    ["brand", "NO BRAND"],
    ["color", "хаки"],
    ["audience", "Женский"],
    ["merge_card", "selfgrade-probe"],
    ["size", ""]
  ]), {sizeMappingValue: "44;46"});
  const byId = Object.fromEntries(report.checks.map((check) => [check.attribute_id, check]));
  assert.equal(byId[10096].status, "in_dictionary");
  assert.equal(byId[10096].dictionary.pages, 2);
  assert.equal(byId[9163].status, "in_dictionary");
  // 集合值 44;46 拆开逐个核对
  assert.equal(byId[4295].status, "in_dictionary");
  assert.equal(byId[8292].status, "free_text");
  assert.equal(byId[31].status, "free_text");
  assert.equal(report.totals.passed, 5);
  assert.equal(report.totals.missing, 0);
  // 端点只读白名单
  assert.ok(report.endpoints.every((path) => path.startsWith("/v1/description-category")));
  assert.equal(report.readonly, true);
});

test("预检：字典里没有的值如实报 not_found，不算通过", async () => {
  const report = await run(new Map([
    ["color", "荧光绿"], // 字典只有 Хаки/Белый/Черный
    ["audience", "Женский"],
    ["merge_card", "x"],
    ["brand", "b"],
    ["size", ""]
  ]), {sizeMappingValue: "44"});
  const color = report.checks.find((check) => check.attribute_id === 10096);
  assert.equal(color.status, "not_found");
  assert.equal(report.totals.dictionary_failed, 1);
  assert.equal(report.totals.passed, 4);
});

test("预检：翻页到上限仍没命中要报 cap_reached，不许装通过", async () => {
  const report = await preflightStore({
    creds: {clientId: "id", apiKey: "key"},
    fetchImpl: fakeFetch(),
    packageAttributes: new Map([["color", "荧光绿"], ["audience", "Женский"], ["merge_card", "x"], ["brand", "b"], ["size", ""]]),
    sizeMappingValue: "44",
    mapping,
    maxDictPages: 1,
    spacingMs: 0
  });
  const color = report.checks.find((check) => check.attribute_id === 10096);
  assert.equal(color.status, "cap_reached");
  assert.equal(color.dictionary.capped, true);
});

test("预检：缺值如实报 missing；别名键也能取到", async () => {
  const report = await run(new Map([
    ["brand", "NO BRAND"],
    ["colour", "хаки"], // 别名：映射键是 color，包内用 colour 也认
    ["gender", "Женский"], // 别名
    ["merge_card", "x"]
  ]), {sizeMappingValue: null});
  const byId = Object.fromEntries(report.checks.map((check) => [check.attribute_id, check]));
  assert.equal(byId[10096].status, "in_dictionary");
  assert.equal(byId[9163].status, "in_dictionary");
  assert.equal(byId[4295].status, "missing");
  assert.match(byId[4295].detail, /没有值/);
  assert.equal(report.totals.missing, 1);
});

test("预检：凭证缺失要报 CREDENTIALS_MISSING，不静默降级", async () => {
  await assert.rejects(
    () => loadCredentials({env: {}, envPath: null}),
    (error) => error.code === "CREDENTIALS_MISSING" && /OZON_CLIENT_ID/.test(error.message)
  );
});

test("预检：readAttributeCsv 认两种表头的 canonical_key 列", () => {
  const master = readAttributeCsv("canonical_key,value,synonyms,confidence\ncolor,хаки,color_name,medium\n");
  assert.equal(master.get("color"), "хаки");
  const projected = readAttributeCsv("platform_key,canonical_key,value,confidence\n#10096 Цвет товара,color,хаки,medium\n");
  assert.equal(projected.get("color"), "хаки");
});
