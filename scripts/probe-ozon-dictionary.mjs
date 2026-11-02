#!/usr/bin/env node
/**
 * 查平台字典里到底有哪些取值（只读）。
 *
 * 为什么需要：字典型属性只能填字典里的项，而字典动辄几千个值、接口分页返回。
 * 猜一个"看起来对"的俄文词进去，提交时会被拒，而且拒因只写"值无效"，不告诉你怎么改。
 *
 * 用法：
 *   node scripts/probe-ozon-dictionary.mjs --attribute 4295 --type-id 93182 [--search универс] [--dump]
 *   node scripts/probe-ozon-dictionary.mjs --attribute 8229 --type-id 93182 --search Платье
 *
 * 参数：
 *   --env <path>      凭证文件（默认项目根 .env），也可用环境变量
 *   --attribute <id>  属性 id
 *   --type-id <id>    叶子类目 type_id
 *   --category-id <id> 父类目 id（不传则自动从类目树按 type_id 反查）
 *   --search <text>   只打印包含该串的取值（大小写不敏感）
 *   --dump            打印全部（默认只打印前 30 条 + 命中项）
 *   --out <path>      另存 JSON
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
const PAGE = 1000;
const MAX_PAGES = 40;

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
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}：${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const attributeId = Number(flag("attribute", 0));
const typeId = Number(flag("type-id", 0));
if (!attributeId || !typeId) {
  console.error("用法：node scripts/probe-ozon-dictionary.mjs --attribute <id> --type-id <id> [--search <text>] [--dump] [--env <path>]");
  process.exit(2);
}

let categoryId = Number(flag("category-id", 0));
if (!categoryId) {
  const tree = await post("/v1/description-category/tree", {language: "DEFAULT"});
  const walk = (node, parentId) => {
    for (const child of node.children ?? []) {
      if (Number(child.type_id) === typeId) return parentId ?? node.description_category_id;
      const hit = walk(child, node.description_category_id ?? parentId);
      if (hit) return hit;
    }
    return null;
  };
  for (const root of tree.result ?? []) {
    categoryId = walk(root, root.description_category_id) ?? categoryId;
    if (categoryId) break;
  }
}
if (!categoryId) {
  console.error("拿不到 description_category_id：显式传 --category-id");
  process.exit(2);
}

const values = [];
let lastValueId = 0;
for (let page = 0; page < MAX_PAGES; page += 1) {
  const body = {
    attribute_id: attributeId,
    description_category_id: categoryId,
    type_id: typeId,
    language: "DEFAULT",
    last_value_id: lastValueId,
    limit: PAGE
  };
  const response = await post("/v1/description-category/attribute/values", body);
  const items = Array.isArray(response.result) ? response.result : [];
  for (const item of items) values.push({id: item.id, value: item.value, info: item.info ?? null, picture: item.picture ?? null});
  if (response.has_next !== true || items.length === 0) break;
  const next = items.at(-1)?.id;
  if (!Number.isFinite(Number(next)) || Number(next) === lastValueId) break;
  lastValueId = Number(next);
}

const search = flag("search");
const dump = args.includes("--dump");
const needle = search ? String(search).toLowerCase() : null;
const hits = needle ? values.filter((item) => String(item.value).toLowerCase().includes(needle)) : [];

console.log(`attribute #${attributeId} · type_id ${typeId} · category_id ${categoryId}`);
console.log(`字典取值 ${values.length} 个（分页拉全）`);
if (needle) {
  console.log(`含「${search}」的取值 ${hits.length} 个：`);
  for (const hit of hits) console.log(`  - ${hit.value}（id ${hit.id}）`);
  if (hits.length === 0) console.log("  （无命中：说明这个写法不在字典里，照它填会被拒）");
}
if (dump) {
  console.log("全部取值：");
  for (const item of values) console.log(`  ${item.value}`);
} else if (!needle) {
  for (const item of values.slice(0, 30)) console.log(`  - ${item.value}`);
  if (values.length > 30) console.log(`  …另有 ${values.length - 30} 个（加 --dump 看全部）`);
}

const out = flag("out");
if (out) {
  await writeFile(resolve(process.cwd(), String(out)), `${JSON.stringify({
    attribute_id: attributeId,
    type_id: typeId,
    description_category_id: categoryId,
    probed_at: new Date().toISOString(),
    total: values.length,
    values
  }, null, 2)}\n`, "utf8");
  console.log(`已存：${out}`);
}
