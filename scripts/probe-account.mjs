#!/usr/bin/env node
/**
 * 账号能力探测：拿到凭证后，先回答"这把钥匙能开哪几扇门"，再谈自动化。
 *
 * 为什么必须先探测：同一家平台，只读 key 与读写 key 能做的事差一个数量级。
 * 让用户去后台猜"我的 key 够不够"没有意义 —— 探一次就知道，而且探的过程不写任何数据。
 *
 * 判定写权限的手法（不产生副作用）：
 *   发一个**参数必然非法**的写请求，看返回码：
 *     401/403 → 没有写权限（门是锁的）
 *     400/404/422 → 有写权限，只是参数不对（门开了，只是钥匙插歪了）
 *   绝不用空对象去"尝试创建"，因为有些接口空对象也会建出一条脏数据。
 *   本脚本只用"明确不存在的 id"或"空数组"，两类都不会落地任何商品。
 *
 * 用法：
 *   node scripts/probe-account.mjs --platform ozon --env <path-to-.env>
 *   node scripts/probe-account.mjs --platform ozon --env <path> --json
 *
 * 产出：out/verification/account-<platform>.json（不含密钥）
 */

import {mkdir, readFile, writeFile} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};

const platform = String(flag("platform", "ozon"));
const envPath = flag("env");
const asJson = args.includes("--json");
if (!envPath) {
  console.error("需要 --env <path>：凭证文件路径（本脚本只读，不复制、不打印密钥）");
  process.exit(2);
}

/** 从 .env 读键值。只返回需要的两个键，且绝不回显值。 */
async function readCreds(path, keys) {
  const text = await readFile(resolve(process.cwd(), String(path)), "utf8").catch(() => null);
  if (text === null) return null;
  const out = {};
  for (const key of keys) {
    const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    out[key] = match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
  }
  return out;
}

const OZON_CAPS = [
  {
    id: "category_tree",
    label: "类目树",
    method: "POST",
    path: "/v1/description-category/tree",
    body: {},
    kind: "read",
    ok: (status, json) => status === 200 && Array.isArray(json?.result),
    detail: (status, json) => (status === 200 ? `顶层类目 ${json.result.length} 个` : `HTTP ${status}`)
  },
  {
    id: "attribute_dict",
    label: "类目属性与字典",
    method: "POST",
    path: "/v1/description-category/attribute",
    body: {description_category_id: 200000933, type_id: 93182, language: "DEFAULT"},
    kind: "read",
    ok: (status, json) => status === 200 && Array.isArray(json?.result),
    detail: (status, json) => (status === 200 ? `属性 ${json.result.length} 个` : `HTTP ${status}`)
  },
  {
    id: "product_list",
    label: "商品列表（店铺规模）",
    method: "POST",
    path: "/v3/product/list",
    body: {filter: {visibility: "ALL"}, limit: 1},
    kind: "read",
    ok: (status, json) => status === 200 && json?.result !== undefined,
    detail: (status, json) => (status === 200 ? `在架商品 ${json.result.total_items ?? 0} 个` : `HTTP ${status}`)
  },
  {
    id: "import_task_read",
    label: "导入任务查询（证明可读到自己的 company）",
    method: "POST",
    path: "/v1/product/import/info",
    body: {task_id: 1},
    kind: "read",
    // 这里 404 反而是"能访问"，因为返回体里带了 company_id；真正没权限是 401/403
    ok: (status, json) => status !== 401 && status !== 403 && Boolean(json?.message ?? json?.result),
    detail: (status, json) => {
      const company = String(json?.message ?? "").match(/company_id:\s*(\d+)/);
      if (company) return `可访问；所属 company_id=${company[1]}`;
      return status === 200 ? "可访问" : `HTTP ${status}`;
    }
  },
  {
    id: "write_probe",
    label: "写权限（安全探测：空数组必然被参数校验拒绝，不落地任何商品）",
    method: "POST",
    path: "/v3/product/import",
    body: {items: []},
    kind: "write-probe",
    detail: (status) => {
      if (status === 401 || status === 403) return "无写权限（门是锁的）";
      if (status === 400 || status === 422) return "有写权限（通过鉴权后被参数校验拦下：必须 1–1000 条）";
      if (status === 200) return "有写权限（空请求被接受，未创建任何商品）";
      // 404 只说明这个路径不存在/已改版，**不能**据此判断权限 —— 判错会让人以为能发布。
      if (status === 404) return "无法判定：该接口路径不存在（可能已改版），换路径再探";
      return `无法判定：HTTP ${status}`;
    },
    verdict: (status) => {
      if (status === 401 || status === 403) return "denied";
      if (status === 400 || status === 422 || status === 200) return "granted";
      return "unknown";
    }
  }
];

async function probeOzon(creds) {
  const headers = {
    "Client-Id": creds.OZON_CLIENT_ID,
    "Api-Key": creds.OZON_API_KEY,
    "Content-Type": "application/json"
  };
  const results = [];
  for (const cap of OZON_CAPS) {
    const started = Date.now();
    let status = 0;
    let json = null;
    let error = null;
    try {
      const response = await fetch(`https://api-seller.ozon.ru${cap.path}`, {
        method: cap.method,
        headers,
        body: JSON.stringify(cap.body),
        signal: AbortSignal.timeout(25000)
      });
      status = response.status;
      const text = await response.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    } catch (err) {
      error = err.message;
    }
    // 写权限三态：granted / denied / unknown。二值化会把"路径不存在"说成"有权限"。
    const writeVerdict = cap.kind === "write-probe" && !error ? cap.verdict(status) : null;
    const passed = error ? false : cap.kind === "write-probe"
      ? writeVerdict === "granted"
      : cap.ok(status, json);
    results.push({
      id: cap.id,
      label: cap.label,
      kind: cap.kind,
      http: status || null,
      ok: passed,
      // detail 对外只说结论，不回显任何请求/响应体里的敏感内容
      detail: error ? `网络错误：${error}` : cap.detail(status, json),
      write_verdict: writeVerdict,
      ms: Date.now() - started
    });
    await new Promise((done) => setTimeout(done, 350)); // 平台有 QPS 限制，别把自己限流
  }
  return results;
}

const CRED_KEYS = {
  ozon: ["OZON_CLIENT_ID", "OZON_API_KEY"]
};

if (!CRED_KEYS[platform]) {
  console.error(`暂不支持探测 ${platform}。已支持：${Object.keys(CRED_KEYS).join(", ")}`);
  console.error("其它平台的凭证形态不同（Shopee/Lazada 是 partner_id + partner_key + shop 授权；TikTok 是 app_key + app_secret + shop_cipher），接入前要先补对应探测用例。");
  process.exit(2);
}

const creds = await readCreds(envPath, CRED_KEYS[platform]);
if (!creds || !creds[CRED_KEYS[platform][0]]) {
  console.error(`在 ${envPath} 里没找到 ${CRED_KEYS[platform].join(" / ")}`);
  process.exit(2);
}

const results = platform === "ozon" ? await probeOzon(creds) : [];

const readOk = results.filter((item) => item.kind === "read" && item.ok).length;
const readTotal = results.filter((item) => item.kind === "read").length;
const writeItem = results.find((item) => item.kind === "write-probe");
const writeVerdict = writeItem?.write_verdict ?? "unknown";
const writeOk = writeVerdict === "granted";

const report = {
  platform,
  probed_at: new Date().toISOString(),
  env_file: basename(String(envPath)),
  // 只记录"有没有"，不记录值本身
  credentials_present: Object.fromEntries(Object.entries(creds).map(([key, value]) => [key, Boolean(value)])),
  read_capabilities: `${readOk}/${readTotal}`,
  write_capability: writeVerdict,
  can_publish: writeOk && readOk >= 3,
  results
};

await mkdir(join(ROOT, "out", "verification"), {recursive: true});
await writeFile(
  join(ROOT, "out", "verification", `account-${platform}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8"
);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`平台 ${platform} · 探测时间 ${report.probed_at}`);
console.log(`凭证：${Object.entries(report.credentials_present).map(([key, ok]) => `${key}=${ok ? "有" : "缺"}`).join("  ")}`);
console.log("");
for (const item of results) {
  const mark = item.ok ? "✓" : "✗";
  console.log(`  ${mark} ${item.label} — ${item.detail}${item.http ? `（HTTP ${item.http}）` : ""}`);
}
console.log("");
console.log(`读取能力：${report.read_capabilities}`);
const writeLabel = {granted: "有", denied: "无（key 只读）", unknown: "无法判定（探测路径不可用，需换路径复核）"}[writeVerdict];
console.log(`写权限：${writeLabel}`);
console.log(`能否直接发布商品：${report.can_publish ? "可以" : writeVerdict === "unknown" ? "未知（先把路径确认清楚）" : "不行"}`);
if (writeVerdict === "unknown") {
  console.log("");
  console.log("写权限未能判定：这不是\"没有权限\"，而是\"这个探测路径打不通\"。");
  console.log("先在该平台的开放平台文档里确认当前的商品导入接口路径，再回来重探。");
} else if (!writeOk) {
  console.log("");
  console.log("要打通「发布」这一段，需要在平台后台把 key 的权限开到可写（Ozon 是 Seller API 的 admin 级 key），");
  console.log("或者单独给一把用于写入的 key。在此之前，本工具只做只读预检与材料准备，不代提交。");
}
console.log("");
console.log(`报告已落盘：out/verification/account-${platform}.json（不含密钥值）`);
process.exit(report.can_publish ? 0 : 1);
