#!/usr/bin/env node
/**
 * 把「这个类目到底要填哪些字段、每个字段怎么填」拉成一份可交付的说明书。
 *
 * 为什么必须有它：只知道字段名不够。卖家真正需要的是——
 *   这一格必不必填 / 是不是从下拉里选 / 能选哪些值 / 能不能多选 / 官方对填写说了什么。
 * 这些都在 `/v1/description-category/attribute` 与 `.../attribute/values` 里，只读即可拿到。
 *
 * 产物：
 *   out/verification/ozon-attribute-rules.json   机器读（给链路用）
 *   docs/商品字段说明书.md                        人读（可直接给卖家/上架人员）
 *
 * 用法：
 *   node scripts/probe-ozon-attribute-rules.mjs                    # 用 sizing.json 记录的类目
 *   node scripts/probe-ozon-attribute-rules.mjs --type-id 93182
 *   node scripts/probe-ozon-attribute-rules.mjs --values 12        # 每个字典属性取前 12 个值
 */
import {readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};
const BASE = "https://api-seller.ozon.ru";
const VALUE_SAMPLE = Number(flag("values", 8));

async function credentials() {
  if (process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) {
    return {clientId: process.env.OZON_CLIENT_ID, apiKey: process.env.OZON_API_KEY};
  }
  const envPath = String(flag("env", join(ROOT, ".env")));
  const text = await readFile(envPath, "utf8");
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (match) map.set(match[1], match[2]);
  }
  if (!map.get("OZON_CLIENT_ID") || !map.get("OZON_API_KEY")) throw new Error(`凭证不全：${envPath}`);
  return {clientId: map.get("OZON_CLIENT_ID"), apiKey: map.get("OZON_API_KEY")};
}

const creds = await credentials();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let lastCall = 0;

/** 官方限流 5 次/秒：串行 + 间隔，避免把自己打成 429。 */
async function post(path, body) {
  const wait = Math.max(0, 220 - (Date.now() - lastCall));
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {"Client-Id": creds.clientId, "Api-Key": creds.apiKey, "Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${path} → HTTP ${response.status}：${text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(text);
}

const sizing = JSON.parse(await readFile(join(ROOT, "regions/RU/sizing.json"), "utf8"));
const ozonSource = sizing.platform_fields?.ozon?.source ?? {};
const typeId = Number(flag("type-id", ozonSource.type_id ?? 0));
const categoryId = Number(flag("category-id", ozonSource.description_category_id ?? sizing.platform_fields?.ozon?.required_attributes?.category_id ?? 0));

if (!typeId) {
  console.error("缺 type-id：先跑 node scripts/probe-ozon-attrs.mjs 或显式传 --type-id");
  process.exit(2);
}

let resolvedCategoryId = categoryId;
if (!resolvedCategoryId) {
  const tree = await post("/v1/description-category/tree", {language: "DEFAULT"});
  resolvedCategoryId = (function walk(nodes, parent) {
    for (const node of nodes ?? []) {
      const id = node.description_category_id ?? parent;
      if (node.type_id === typeId) return id;
      const hit = walk(node.children, id);
      if (hit) return hit;
    }
    return null;
  })(tree.result, null);
}

const attributeResponse = await post("/v1/description-category/attribute", {
  description_category_id: resolvedCategoryId,
  type_id: typeId,
  language: "DEFAULT"
});
const attributes = attributeResponse.result ?? [];

/** 只对"有字典"的属性拉取值：没有字典的是自由填，拉不到东西。 */
const rules = [];
for (const attribute of attributes) {
  const rule = {
    id: attribute.id,
    name: attribute.name,
    description: attribute.description ?? null,
    type: attribute.type ?? null,
    is_required: attribute.is_required === true,
    is_collection: attribute.is_collection === true,
    dictionary_id: Number(attribute.dictionary_id) > 0 ? attribute.dictionary_id : null,
    dictionary_values: null,
    dictionary_values_total: null,
    dictionary_probe: null
  };

  if (rule.dictionary_id) {
    try {
      const values = await post("/v1/description-category/attribute/values", {
        attribute_id: attribute.id,
        description_category_id: resolvedCategoryId,
        type_id: typeId,
        language: "DEFAULT",
        last_value_id: 0,
        limit: Math.max(VALUE_SAMPLE, 1)
      });
      const list = values.result ?? [];
      rule.dictionary_values = list.map((item) => item.value);
      rule.dictionary_values_total = values.has_next === true ? `>${list.length}` : list.length;
    } catch (error) {
      rule.dictionary_probe = `取值失败：HTTP ${error.status ?? "?"}`;
    }
  }
  rules.push(rule);
}

const required = rules.filter((rule) => rule.is_required);
const dictStats = rules.filter((rule) => rule.dictionary_id);

const evidence = {
  probed_at: new Date().toISOString(),
  source: {
    kind: "ozon-seller-api",
    endpoints: ["/v1/description-category/attribute", "/v1/description-category/attribute/values"],
    readonly: true
  },
  category: {description_category_id: resolvedCategoryId, type_id: typeId},
  totals: {
    attributes: rules.length,
    required: required.length,
    with_dictionary: dictStats.length,
    free_text: rules.length - dictStats.length
  },
  rules
};

await writeFile(join(ROOT, "out/verification/ozon-attribute-rules.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

/** 人读版：把"字段名 + 规则 + 怎么填"排成一张能照着做的表。 */
const lines = [
  "# 商品字段说明书（Ozon · 女装连衣裙类目）",
  "",
  `> 生成时间 ${evidence.probed_at.slice(0, 16).replace("T", " ")} · 来源：Seller API 只读实测`,
  `> 类目：description_category_id=${resolvedCategoryId} · type_id=${typeId}`,
  `> 共 ${rules.length} 个字段，其中必填 ${required.length} 个、下拉选择 ${dictStats.length} 个、自由填 ${rules.length - dictStats.length} 个`,
  "",
  "## 必填字段（这 6 项不填，审核直接打回）",
  "",
  "| 字段 | 编号 | 怎么填 | 可选值（示例） |",
  "|---|---|---|---|"
];
for (const rule of required) {
  const how = [
    rule.is_collection ? "可多选" : "单选",
    rule.dictionary_id ? "从下拉里选" : "自由填写"
  ].join(" · ");
  const values = rule.dictionary_values?.length
    ? rule.dictionary_values.slice(0, 6).join(" / ") + (rule.dictionary_values_total === rule.dictionary_values.length ? "" : " …")
    : rule.dictionary_probe ?? "自由填";
  lines.push(`| ${rule.name} | #${rule.id} | ${how} | ${values} |`);
}

lines.push(
  "",
  "## 其余字段（选填，填得越全曝光越好）",
  "",
  "| 字段 | 编号 | 规则 | 官方说明（原文） |",
  "|---|---|---|---|"
);
for (const rule of rules.filter((item) => !item.is_required)) {
  const how = [rule.is_collection ? "可多选" : "单选", rule.dictionary_id ? "下拉选择" : "自由填"].join(" · ");
  const desc = (rule.description ?? "").replace(/\|/g, "/").slice(0, 80);
  lines.push(`| ${rule.name} | #${rule.id} | ${how} | ${desc || "—"} |`);
}

lines.push(
  "",
  "## 怎么用这份说明书",
  "",
  "1. 必填 6 项先填，缺一项都过不了审核；",
  "2. 下拉字段必须用官方字典里的值，自己编的词会被拒；",
  "3. 官方说明那一列是平台自己的话术，涉及免责/合规的句子要照做；",
  "4. 机器可读版本：`out/verification/ozon-attribute-rules.json`（字段 id、字典值、是否必填都在里面）。"
);

await writeFile(join(ROOT, "docs/商品字段说明书.md"), `${lines.join("\n")}\n`, "utf8");

console.log(`类目 ${resolvedCategoryId}/${typeId}：字段 ${rules.length} 个（必填 ${required.length}，下拉 ${dictStats.length}，自由 ${rules.length - dictStats.length}）`);
console.log("必填字段与取值规则：");
for (const rule of required) {
  const sample = rule.dictionary_values?.length ? rule.dictionary_values.slice(0, 4).join(" / ") : "自由填";
  console.log(`  [必填] #${rule.id} ${rule.name}${rule.is_collection ? "（可多选）" : ""} → ${sample}`);
}
console.log("\n已生成：out/verification/ozon-attribute-rules.json");
console.log("已生成：docs/商品字段说明书.md");
