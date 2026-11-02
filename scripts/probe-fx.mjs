#!/usr/bin/env node
/**
 * 补齐法域汇率：把 9 个目标币种一次拉全，写进 data/variables/fx.json。
 *
 * 为什么必须补：定价公式里的分母法要用「1 人民币 = 多少目标币」，
 * 缺这个汇率，9 个法域里有 7 个算不出价 —— 只能出包不能出价，新手拿到手还是不能卖。
 *
 * 纪律：
 *   - 已有条目（带交叉核对的 CNY/RUB）不覆盖，只补缺的币种，避免把交叉核对记录冲掉；
 *   - 单一来源的币种标 cross_check 为空并在 note 里写明「单源」，不假装已交叉验证；
 *   - 失败的币种写 null + stale，不拿相邻币种顶替。
 */
import {readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const dry = args.includes("--dry");

/** 目标是"结算币"，不是"平台币"：同一法域多平台共用一种结算币。 */
const TARGETS = ["CNY", "RUB", "SGD", "MYR", "THB", "PHP", "IDR", "VND", "AED", "SAR"];
const PRIMARY = "https://open.er-api.com/v6/latest/USD";
const CROSS = "https://api.frankfurter.dev/v1/latest?base=USD";

const fetchedAt = new Date().toISOString();

async function getJson(url) {
  const response = await fetch(url, {headers: {Accept: "application/json"}, signal: AbortSignal.timeout(25000)});
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), {status: response.status});
  return response.json();
}

const file = join(ROOT, "data/variables/fx.json");
const existing = JSON.parse(await readFile(file, "utf8"));
const byKey = new Map(existing.map((fact) => [fact.key, fact]));

let primary;
try {
  primary = await getJson(PRIMARY);
} catch (error) {
  console.error(`主源失败：${error.message}。没有主源就不写盘，避免把旧价当新价。`);
  process.exit(1);
}
const rates = primary?.rates ?? {};
const providerDate = primary?.time_last_update_utc ?? null;

let crossRates = {};
let crossError = null;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    crossRates = (await getJson(CROSS))?.rates ?? {};
    crossError = null;
    break;
  } catch (error) {
    crossError = error.message;
    await new Promise((done) => setTimeout(done, 1200));
  }
}
if (crossError) console.warn(`交叉核对源不可用（${crossError}）：本次只写单源，note 里会标明。`);

const added = [];
const skipped = [];
for (const currency of TARGETS) {
  const key = `fx.USD_${currency}`;
  if (byKey.has(key)) {
    // 已有条目不动数值，但如果它没有交叉核对、而现在 ECB 有这个币种，就补上核对记录。
    const fact = byKey.get(key);
    for (const field of ["conflict_id", "override"]) {
      if (!(field in fact)) fact[field] = null;
    }
    if (!("confidence" in fact)) fact.confidence = fact.source_type === "official" ? "official" : "secondary";
    if (!("status" in fact)) fact.status = fact.source_type === "official" ? "final" : "candidate";
    const crossValue = Number(crossRates[currency]);
    if ((fact.cross_check ?? []).length === 0 && Number.isFinite(crossValue) && crossValue > 0 && Number.isFinite(Number(fact.value))) {
      fact.cross_check = [{
        source: "frankfurter-ecb",
        value: crossValue,
        note: `ECB 参考汇率；补核对 fetched_at=${fetchedAt}; source_url=${CROSS}`
      }];
      fact.divergence_pct = Math.round(Math.abs(Number(fact.value) - crossValue) / crossValue * 10000) / 100;
      fact.note = `${fact.note ?? ""}；已补 ECB 交叉核对`.trim();
      added.push(`${currency} 补交叉核对（ECB ${crossValue}）`);
    } else {
      skipped.push(`${currency}（已有，保留原记录）`);
    }
    continue;
  }
  const value = Number(rates[currency]);
  const crossValue = Number(crossRates[currency]);
  const usable = Number.isFinite(value) && value > 0;
  const crossCheck = Number.isFinite(crossValue) && crossValue > 0
    ? [{
      source: "frankfurter-ecb",
      value: crossValue,
      note: `ECB 参考汇率；fetched_at=${fetchedAt}; source_url=${CROSS}`
    }]
    : [];
  const fact = {
    key,
    value: usable ? value : null,
    unit: `${currency}/USD`,
    scope: {region: null, platform: null, category: null},
    source: "open-er-api",
    source_url: PRIMARY,
    source_type: usable ? "official" : "secondary",
    confidence: usable ? "official" : "unverified",
    status: usable ? "final" : "unverified",
    conflict_id: null,
    fetched_at: fetchedAt,
    ttl_hours: 24,
    stale: !usable,
    cross_check: crossCheck,
    override: null,
    divergence_pct: crossCheck.length > 0
      ? Math.round(Math.abs(value - crossValue) / crossValue * 10000) / 100
      : null,
    note_internal: usable
      ? `${currency} 兑美元${providerDate ? `（数据时间 ${providerDate}）` : ""}${crossCheck.length ? "；已与 ECB 参考汇率交叉核对" : "；单源，无交叉核对"}`
      : `主源没有返回 ${currency}，本币种不可用`
  };
  byKey.set(key, fact);
  added.push(`${currency}=${usable ? value : "null"}${crossCheck.length ? `（ECB ${crossValue}）` : "（单源）"}`);
}

const merged = [...byKey.values()].map((fact) => {
  const clean = {...fact};
  const internal = clean.note_internal ?? clean.note ?? null;
  delete clean.note;
  delete clean.note_internal;
  // fact schema 不允许额外字段：把人类可读的说明压进 source 字符串，不丢信息也不脏数据。
  if (internal) clean.source = `${clean.source}（${internal}）`;
  // 反复跑会把括号里的说明越堆越长：这里统一重建成一句话，避免 source 变成垃圾场。
  const base = String(clean.source).split("（")[0];
  const currency = String(clean.key).replace("fx.USD_", "");
  const crossCount = (clean.cross_check ?? []).length;
  // 不能一律写成"已与 ECB 核对"：AED/RUB 的交叉源是央行，不是 ECB。
  const cross = crossCount > 0 ? `已交叉核对 ${crossCount} 源` : "单源，无交叉核对";
  clean.source = `${base}（USD→${currency}；${String(clean.fetched_at).slice(0, 10)}；${cross}）`;
  return clean;
}).sort((left, right) => String(left.key).localeCompare(String(right.key)));
if (!dry) {
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

console.log(`目标币种 ${TARGETS.length} 个 · 新增 ${added.length} 个 · 跳过 ${skipped.length} 个${dry ? "（dry-run，未写盘）" : ""}`);
for (const item of added) console.log(`  + ${item}`);
for (const item of skipped) console.log(`  = ${item}`);
