#!/usr/bin/env node
/**
 * 只读探测 Ozon Seller API 的权限范围。
 *
 * 为什么只读：写端点（改价、改库存、导入商品）一旦调用就会**真的改动线上店铺**。
 * 探测权限不需要写，所以这里只打读端点，用返回码判断"该域能不能用"。
 *
 * 判定口径：
 *   200        → 该域可用
 *   401/403    → 该域无权限（key 生成时未勾选，或 key 失效）
 *   404        → 端点不存在（版本变了），不代表没权限
 *   429        → 限流（可用，但当前请求太快）
 * 其他                   → 原样报出，不猜
 *
 * 用法：
 *   node scripts/probe-ozon-scopes.mjs
 *   node scripts/probe-ozon-scopes.mjs --env <path-to-.env>
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
  if (!map.get("OZON_CLIENT_ID") || !map.get("OZON_API_KEY")) {
    throw new Error(`凭证不全（缺 OZON_CLIENT_ID / OZON_API_KEY）：${envPath}`);
  }
  return {clientId: map.get("OZON_CLIENT_ID"), apiKey: map.get("OZON_API_KEY")};
}

/** 只读端点清单：每一项对应一个业务域，用来判断权限边界。 */
const READ_ENDPOINTS = [
  {domain: "类目与属性", path: "/v1/description-category/tree", body: {language: "DEFAULT"}},
  {domain: "商品列表", path: "/v3/product/list", body: {filter: {}, last_id: "", limit: 1}},
  {domain: "商品信息", path: "/v3/product/info/list", body: (ctx) => ({sku: ctx.firstSku ? [ctx.firstSku] : []}), needsSku: true},
  {domain: "价格", path: "/v5/product/info/prices", body: {filter: {visibility: "ALL"}, limit: 1}},
  {domain: "库存", path: "/v4/product/info/stocks", body: {filter: {visibility: "ALL"}, limit: 1}},
  {domain: "仓库", path: "/v1/warehouse/list", body: {}},
  {domain: "订单(FBS)", path: "/v2/posting/fbs/list", body: {dir: "ASC", filter: {}, limit: 1, offset: 0, with: {analytics_data: false, barcodes: false}}},
  {domain: "促销活动", path: "/v1/actions", method: "GET", body: null},
  {domain: "报表", path: "/v1/report/list", body: {page: 1, page_size: 1}}
];

function verdict(status) {
  if (status === 200) return "可用";
  if (status === 401) return "key 无效或过期";
  if (status === 403) return "无权限（key 未勾选该域）";
  if (status === 404) return "端点不存在（版本可能变了）";
  if (status === 429) return "可用（被限流）";
  return `未预期（HTTP ${status}）`;
}

const creds = await credentials();
console.log(`开始只读探测（Client-Id ${String(creds.clientId).slice(0, 3)}***）…\n`);

const ctx = {firstSku: null};
try {
  const probe = await fetch(`${BASE}/v3/product/list`, {
    method: "POST",
    headers: {"Client-Id": creds.clientId, "Api-Key": creds.apiKey, "Content-Type": "application/json"},
    body: JSON.stringify({filter: {}, last_id: "", limit: 1})
  });
  if (probe.ok) {
    const data = await probe.json();
    ctx.firstSku = data?.result?.items?.[0]?.sku ? String(data.result.items[0].sku) : null;
  }
} catch { /* 取不到就空跑，商品信息项会如实报参数问题 */ }

const results = [];
for (const endpoint of READ_ENDPOINTS) {
  let status = null;
  let detail = "";
  try {
    const bodyValue = typeof endpoint.body === "function" ? endpoint.body(ctx) : endpoint.body;
    const response = await fetch(`${BASE}${endpoint.path}`, {
      method: endpoint.method ?? "POST",
      headers: {
        "Client-Id": creds.clientId,
        "Api-Key": creds.apiKey,
        "Content-Type": "application/json"
      },
      ...(bodyValue === null ? {} : {body: JSON.stringify(bodyValue)})
    });
    status = response.status;
    const text = await response.text();
    detail = text.slice(0, 200);
  } catch (error) {
    status = -1;
    detail = String(error.message ?? error);
  }
  const mark = status === 200 ? "✅" : status === 429 ? "🟡" : "❌";
  console.log(`${mark} ${endpoint.domain.padEnd(10, "　")} ${endpoint.path} → ${verdict(status)}`);
  results.push({domain: endpoint.domain, path: endpoint.path, status, verdict: verdict(status), detail});
  // 官方限流 5 次/秒，这里串行且留间隔，避免自己把自己 429 掉
  await new Promise((done) => setTimeout(done, 260));
}

const usable = results.filter((item) => item.status === 200);
const evidence = {
  probed_at: new Date().toISOString(),
  mode: "read-only",
  base: BASE,
  note: "只读探测：未调用任何写端点（改价/改库存/导入商品）。写权限无法在不写入的前提下确证，需在卖家后台看 key 的勾选项。",
  usable_domains: usable.map((item) => item.domain),
  results
};
await writeFile(join(ROOT, "out/verification/ozon-scopes.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`\n可用域 ${usable.length}/${results.length}：${usable.map((item) => item.domain).join("、") || "（无）"}`);
console.log("证据：out/verification/ozon-scopes.json");
console.log("说明：写权限（改价/改库存/导入商品）不能用只读方式确证，需在卖家后台查看该 API key 的勾选范围。");
