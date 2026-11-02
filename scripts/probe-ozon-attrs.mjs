#!/usr/bin/env node
/**
 * 用 Ozon 官方 Seller API 反查类目属性，确认尺码字段的真实名字。
 *
 * 为什么要有它：尺码字段名只存在于卖家后台/官方 API。公网接口被 WAF 挡、开发者文档有反爬，
 * 但**自己有店铺凭证**时就不必猜 —— 直接问平台：
 *   1) /v1/description-category/tree         拿类目树（含 leaf 的 type_id）
 *   2) /v1/description-category/attribute    拿该类目的属性字典
 *   3) 过滤出尺码相关属性，落成证据 + 可直接写进 regions/<CC>/sizing.json 的建议值
 *
 * 凭证来源：默认读上架端 skill 的 .env（OZON_CLIENT_ID / OZON_API_KEY），
 * 也可用 --env <path> 或环境变量覆盖。**凭证不写进任何输出文件。**
 *
 * 用法：
 *   node scripts/probe-ozon-attrs.mjs                      # 默认查女装主类目
 *   node scripts/probe-ozon-attrs.mjs --query Юбки         # 查指定类目名
 *   node scripts/probe-ozon-attrs.mjs --apply             # 顺带写回 regions/RU/sizing.json
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
const has = (name) => args.includes(`--${name}`);

// 默认读本仓库根目录的 .env（独立自包含：不依赖其他 skill 目录）
const ENV_PATH = String(flag("env", join(ROOT, ".env")));
const QUERY = String(flag("query", "Женская одежда"));
const PREFER = String(flag("type", "Платье"));
// 排除同名但不同品类的干扰项：实测踩过——「Платье гоу-гоу」也会被 Платье 匹配到
const EXCLUDE = ["Детск", "Игрушк", "эротическ", "гоу-гоу", "Белье"];
const BASE = "https://api-seller.ozon.ru";

async function loadCredentials() {
  const fromEnv = {clientId: process.env.OZON_CLIENT_ID, apiKey: process.env.OZON_API_KEY};
  if (fromEnv.clientId && fromEnv.apiKey) return fromEnv;
  let text;
  try {
    text = await readFile(ENV_PATH, "utf8");
  } catch (error) {
    throw new Error(`读不到凭证文件 ${ENV_PATH}：${error.message}`);
  }
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (match) map.set(match[1], match[2]);
  }
  const clientId = map.get("OZON_CLIENT_ID");
  const apiKey = map.get("OZON_API_KEY");
  if (!clientId || !apiKey) throw new Error("凭证文件里缺 OZON_CLIENT_ID / OZON_API_KEY");
  return {clientId, apiKey};
}

async function post(path, body, credentials) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Client-Id": credentials.clientId,
      "Api-Key": credentials.apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}：${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** 类目树是三层：根类目 → 叶子（带 type_id）。这里把叶子摊平，便于按名字找。 */
function flattenLeaves(nodes, trail = [], parentCategoryId = null) {
  const leaves = [];
  for (const node of nodes ?? []) {
    // 叶子层的名字在 type_name 里，中间层在 category_name —— 两个都要取，否则路径是空的
    const nextTrail = [...trail, node.type_name ?? node.category_name ?? "(未命名)"];
    const categoryId = node.description_category_id ?? parentCategoryId;
    if (Array.isArray(node.children) && node.children.length > 0) {
      leaves.push(...flattenLeaves(node.children, nextTrail, categoryId));
    } else if (node.type_id) {
      leaves.push({
        description_category_id: categoryId,
        type_id: node.type_id,
        path: nextTrail.join(" / ")
      });
    }
  }
  return leaves;
}

const credentials = await loadCredentials();
console.log(`凭证就绪（Client-Id ${String(credentials.clientId).slice(0, 3)}***），开始查询…`);

const tree = await post("/v1/description-category/tree", {language: "DEFAULT"}, credentials);
const leaves = flattenLeaves(tree.result ?? []);
console.log(`类目树：${leaves.length} 个叶子类目`);

const matched = leaves.filter((leaf) =>
  leaf.path.toLowerCase().includes(QUERY.toLowerCase()) &&
  !EXCLUDE.some((word) => leaf.path.includes(word))
);
if (matched.length === 0) {
  const hints = leaves.filter((leaf) => /одежд/i.test(leaf.path)).map((leaf) => leaf.path);
  console.error(`没有匹配「${QUERY}」的叶子类目。含「одежд」的路径共 ${hints.length} 条，前 15 条：`);
  for (const hint of hints.slice(0, 15)) console.error(`  - ${hint}`);
  process.exit(2);
}
const preferred = matched.filter((leaf) => leaf.path.includes(PREFER));
const target = preferred[0] ?? matched[0];
console.log(`目标类目：${target.path}（category_id=${target.description_category_id}, type_id=${target.type_id}）`);

const attributes = await post("/v1/description-category/attribute", {
  description_category_id: target.description_category_id,
  type_id: target.type_id,
  language: "DEFAULT"
}, credentials);

const list = attributes.result ?? [];
console.log(`属性总数：${list.length}`);

const sizeRelated = list.filter((attribute) => /размер|рост|обхват|длина/i.test(String(attribute.name ?? "")));
const sizeAttributes = sizeRelated.map((attribute) => ({
  id: attribute.id,
  name: attribute.name,
  description: attribute.description ?? null,
  type: attribute.type ?? null,
  is_required: attribute.is_required ?? null,
  is_collection: attribute.is_collection ?? null,
  dictionary_id: attribute.dictionary_id ?? null,
  group_name: attribute.group_name ?? null
}));

const evidence = {
  probed_at: new Date().toISOString(),
  source: {
    kind: "ozon-seller-api",
    endpoints: ["/v1/description-category/tree", "/v1/description-category/attribute"],
    note: "官方 Seller API 实测；凭证来自本机 .env，未写入本文件"
  },
  query: QUERY,
  category: target,
  matched_categories: matched.slice(0, 10).map((leaf) => leaf.path),
  attributes_total: list.length,
  size_attributes: sizeAttributes
};

await writeFile(join(ROOT, "out/verification/ozon-size-attributes.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`\n尺码相关属性 ${sizeAttributes.length} 个：`);
for (const attribute of sizeAttributes) {
  console.log(`  #${attribute.id} ${attribute.name}${attribute.is_required ? "（必填）" : ""}${attribute.dictionary_id ? ` 字典#${attribute.dictionary_id}` : ""}`);
}

// 取「真正的尺码列」：必填优先，其次名字精确等于本地尺码口径（如 Российский размер）
const primary = sizeAttributes.find((attribute) => attribute.is_required === true)
  ?? sizeAttributes.find((attribute) => /^российск/i.test(String(attribute.name)))
  ?? sizeAttributes.find((attribute) => /^размер/i.test(String(attribute.name)))
  ?? null;

if (!primary) {
  console.log("\n没找到明确叫「尺码」的属性，不做写回。");
  process.exit(0);
}

console.log(`\n主尺码属性：#${primary.id}「${primary.name}」`);

if (!has("apply")) {
  console.log("（只取证，未写回配置。加 --apply 写回 regions/RU/sizing.json）");
  process.exit(0);
}

const sizingPath = join(ROOT, "regions/RU/sizing.json");
const sizing = JSON.parse(await readFile(sizingPath, "utf8"));

/** 语义分组：把官方属性按用途归类，写进配置供映射层直接取用。 */
const pick = (pattern) => sizeAttributes.find((attribute) => pattern.test(String(attribute.name))) ?? null;
const sizeTable = pick(/таблица размеров/i);
const manufacturerSize = pick(/размер производителя/i);
const related = [
  pick(/^рост$/i),
  pick(/тип ростовки/i),
  pick(/длина юбки|длина платья/i),
  pick(/размер на модели/i),
  pick(/рост модели/i)
].filter(Boolean).map((attribute) => ({id: attribute.id, name: attribute.name, dictionary_id: attribute.dictionary_id || null}));

sizing.platform_fields.ozon = {
  shape: "attribute",
  size_attribute: primary.name,
  size_attribute_id: primary.id,
  size_attribute_required: primary.is_required ?? null,
  size_attribute_is_collection: primary.is_collection ?? null,
  size_attribute_dictionary_id: primary.dictionary_id || null,
  // 官方描述明确：多码用分号串起来（42;44），卡片显示区间；这是 collection 语义，不是"一卡一码"
  multi_size_separator: primary.is_collection ? ";" : null,
  size_table_attribute: sizeTable
    ? {id: sizeTable.id, name: sizeTable.name, type: sizeTable.type, note: sizeTable.description}
    : null,
  manufacturer_size_attribute: manufacturerSize
    ? {id: manufacturerSize.id, name: manufacturerSize.name, note: manufacturerSize.description}
    : null,
  related_attributes: related,
  international_attribute: null,
  international_note: "该子类目（Одежда/Платье）的属性字典里没有「国际尺码」字段：后台查不到，配置不保留臆造的字段名",
  status: "confirmed_api",
  source: {
    kind: "ozon-seller-api",
    endpoint: "/v1/description-category/attribute",
    category: target.path,
    type_id: target.type_id,
    probed_at: evidence.probed_at
  },
  note: `官方 Seller API 实测于 ${evidence.probed_at.slice(0, 10)}；类目 ${target.path}；共 ${list.length} 个属性，尺码相关 ${sizeAttributes.length} 个`
};
sizing.confirmation = {
  ...sizing.confirmation,
  status: "confirmed_by_seller",
  confirmed_at: evidence.probed_at.slice(0, 10),
  confirmed_note: "Ozon 侧由 Seller API 实测确认（非人工抄写）；WB 侧仍待确认"
};
await writeFile(sizingPath, `${JSON.stringify(sizing, null, 2)}\n`, "utf8");
console.log(`已写回 ${sizingPath}：ozon.size_attribute = 「${primary.name}」(#${primary.id})，status = confirmed_api`);
if (sizeTable) console.log(`  尺码表属性：#${sizeTable.id}「${sizeTable.name}」为 ${sizeTable.type}（JSON 字符串）`);
if (related.length > 0) console.log(`  相关属性 ${related.length} 个：${related.map((item) => `${item.name}#${item.id}`).join("、")}`);
console.log("  国际尺码：该类目无此属性 → 置 null 并写明原因（不再保留臆造字段名）");
