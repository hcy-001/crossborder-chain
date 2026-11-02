#!/usr/bin/env node
/**
 * 拉「该类目的平台必填属性」清单 —— 只读，不提交任何东西。
 *
 * 为什么这件事重要：跨境上架被拒，最常见的原因不是图片不好看，是**必填属性没填**。
 * 平台后台不会一次告诉你缺哪个，审核一遍遍打回。所以先把必填项拿到手，
 * 让人在上传前就知道"这个类目一共要填几项、哪几项是硬的"。
 *
 * 边界（必须说清）：本脚本给的是**平台属性名**，而包内 attributes.csv 用的是我们自己的
 * canonical_key，两边还没有建立映射。所以它回答"平台要什么"，不回答"我们填够了没"。
 *
 * 用法：
 *   node scripts/ozon-required-attrs.mjs                          # 用 sizing.json 里记的类目
 *   node scripts/ozon-required-attrs.mjs --type-id 93182
 *   node scripts/ozon-required-attrs.mjs --category-id 200000933 --type-id 93182
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

async function post(path, body, creds) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {"Client-Id": creds.clientId, "Api-Key": creds.apiKey, "Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const sizing = JSON.parse(await readFile(join(ROOT, "regions/RU/sizing.json"), "utf8"));
const ozonSource = sizing.platform_fields?.ozon?.source ?? {};
const typeId = Number(flag("type-id", ozonSource.type_id ?? 0));
const categoryId = Number(flag("category-id", 0)) || (ozonSource.category
  ? null
  : null);

if (!typeId) {
  console.error("缺 --type-id。可先跑 node scripts/probe-ozon-attrs.mjs 取到类目，或看 regions/RU/sizing.json 的 ozon.source");
  process.exit(2);
}

const creds = await credentials();
// category_id 由树的父级决定；没有显式给就退回 sizing.json 记录值
let resolvedCategoryId = categoryId;
if (!resolvedCategoryId) {
  const tree = await post("/v1/description-category/tree", {language: "DEFAULT"}, creds);
  const found = (function walk(nodes, parent) {
    for (const node of nodes ?? []) {
      const id = node.description_category_id ?? parent;
      if (node.type_id === typeId) return id;
      const hit = walk(node.children, id);
      if (hit) return hit;
    }
    return null;
  })(tree.result, null);
  resolvedCategoryId = found;
}
if (!resolvedCategoryId) {
  console.error(`没找到 type_id=${typeId} 所属类目`);
  process.exit(2);
}

const attributes = await post("/v1/description-category/attribute", {
  description_category_id: resolvedCategoryId,
  type_id: typeId,
  language: "DEFAULT"
}, creds);

const list = attributes.result ?? [];
const required = list.filter((attribute) => attribute.is_required === true);
const withDictionary = required.filter((attribute) => Number(attribute.dictionary_id) > 0);

const evidence = {
  probed_at: new Date().toISOString(),
  source: {kind: "ozon-seller-api", endpoint: "/v1/description-category/attribute", readonly: true},
  category: {description_category_id: resolvedCategoryId, type_id: typeId},
  attributes_total: list.length,
  required_total: required.length,
  required: required.map((attribute) => ({
    id: attribute.id,
    name: attribute.name,
    type: attribute.type ?? null,
    is_collection: attribute.is_collection ?? null,
    dictionary_id: Number(attribute.dictionary_id) > 0 ? attribute.dictionary_id : null,
    description: attribute.description ?? null
  })),
  note: "这是平台要什么；包内 attributes.csv 用的是内部 canonical_key，两边映射尚未建立（已知缺口），所以不能据此判断我们填够了没有。"
};

await writeFile(join(ROOT, "out/verification/ozon-required-attrs.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`类目 ${resolvedCategoryId}/${typeId}：属性 ${list.length} 个，其中必填 ${required.length} 个（含字典值 ${withDictionary.length} 个）`);
for (const attribute of required) {
  const tag = attribute.dictionary_id > 0 ? `字典#${attribute.dictionary_id}` : "自由值";
  console.log(`  [必填] #${attribute.id} ${attribute.name}（${attribute.type}，${tag}${attribute.is_collection ? "，可多选" : ""}）`.replace("（String", "（文本"));
}
console.log('\n已写证据：out/verification/ozon-required-attrs.json');

if (args.includes('--apply')) {
  const sizing = JSON.parse(await readFile(join(ROOT, 'regions/RU/sizing.json'), 'utf8'));
  sizing.platform_fields.ozon.required_attributes = {
    probed_at: evidence.probed_at,
    total: required.length,
    items: required.map((attribute) => ({
      id: attribute.id,
      name: attribute.name,
      type: attribute.type ?? null,
      is_collection: attribute.is_collection ?? null,
      dictionary_id: Number(attribute.dictionary_id) > 0 ? attribute.dictionary_id : null
    }))
  };
  await writeFile(join(ROOT, 'regions/RU/sizing.json'), `${JSON.stringify(sizing, null, 2)}\n`, 'utf8');
  console.log(`已写回 regions/RU/sizing.json：ozon.required_attributes（${required.length} 项）`);
}
console.log("注意：本清单是「平台要什么」；包内属性键与平台属性名的映射尚未建立，不能据此判断已填够。");
