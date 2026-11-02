#!/usr/bin/env node
/**
 * 信息源可达性探针：把「不同地区到底能不能取到信号」问成一组 HTTP 事实。
 *
 * 为什么必须先测：配置里写一串 allowed 名单（tiktok/instagram/vk…）不等于能取到数据。
 * 这些平台大多没有公开趋势 API，有反爬或需要账号。没测过就写进链路，等于假装有数据源。
 *
 * 判定口径（只读，不绕任何反爬）：
 *   2xx            → 可达（还要看是否返回真实内容，见 sample 字段）
 *   401 / 403      → 需要授权或被反爬拦截
 *   3xx → 登录页    → 需要账号
 *   超时/网络错误   → 该地区从本机不可直连
 *
 * 用法：
 *   node scripts/probe-signal-sources.mjs              # 测全部
 *   node scripts/probe-signal-sources.mjs --region RU  # 只测某地区
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
const onlyRegion = flag("region");

const registry = JSON.parse(await readFile(join(ROOT, "data/signal-sources.json"), "utf8"));
const sources = registry.sources.filter((source) =>
  !onlyRegion || (source.regions ?? []).includes("*") || (source.regions ?? []).includes(String(onlyRegion))
);

/** 读本仓 .env，给需要授权的源注入 header —— 不带凭证的 401 会被误判成"源不可达"。 */
async function loadEnv() {
  const text = await readFile(join(ROOT, ".env"), "utf8").catch(() => "");
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (match) map.set(match[1], match[2]);
  }
  return map;
}
const ENV = await loadEnv();

function authHeaders(source) {
  if (source.auth === "ozon") {
    const clientId = process.env.OZON_CLIENT_ID ?? ENV.get("OZON_CLIENT_ID");
    const apiKey = process.env.OZON_API_KEY ?? ENV.get("OZON_API_KEY");
    if (clientId && apiKey) return {"Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json"};
  }
  return {};
}

async function probe(source) {
  if (!source.probe || !source.endpoint) {
    return {status: null, verdict: "manual", detail: "人工取样，无自动探测"};
  }
  const url = source.endpoint + (source.probe.path ?? "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: source.probe.method ?? "GET",
      headers: {"User-Agent": "Mozilla/5.0 (compatible; signal-probe/1.0)", ...authHeaders(source)},
      ...(source.auth === "ozon" ? {method: "POST", body: JSON.stringify({language: "DEFAULT"})} : {}),
      redirect: "manual",
      signal: controller.signal
    });
    const text = await response.text().catch(() => "");
    const sample = text.slice(0, 120).replace(/\s+/g, " ");
    let verdict;
    if (response.status >= 200 && response.status < 300) {
      // 200 不等于可用：VK 这类会返回 error_code（缺 token/参数），Wordstat 返回登录页
      if (source.requires_login) verdict = "needs_login";
      else if (/"error"/.test(text) && /error_code|error_msg/.test(text)) verdict = source.requires_token ? "needs_token" : "api_error";
      else if (/Вордстат|login|signin/i.test(text) && text.length < 4000) verdict = "needs_login";
      else verdict = "reachable";
    }
    else if (response.status === 401 || response.status === 403) verdict = "auth_or_waf";
    else if (response.status >= 300 && response.status < 400) verdict = "redirect";
    else verdict = `http_${response.status}`;
    return {status: response.status, verdict, sample};
  } catch (error) {
    const aborted = error.name === "AbortError";
    return {status: null, verdict: aborted ? "timeout" : "network_error", detail: String(error.message ?? error).slice(0, 120)};
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const source of sources) {
  const result = await probe(source);
  results.push({id: source.id, tier: source.tier, kind: source.kind, what: source.what, endpoint: source.endpoint, ...result});
  const mark = result.verdict === "reachable" ? "✅" : result.verdict === "manual" ? "✋" : "❌";
  console.log(`${mark} ${source.id.padEnd(24)} ${String(result.status ?? "-").padStart(4)}  ${result.verdict}`);
  await new Promise((done) => setTimeout(done, 150));
}

const evidence = {
  probed_at: new Date().toISOString(),
  mode: "read-only（不绕过任何反爬/登录）",
  region_filter: onlyRegion ?? "all",
  summary: {
    total: results.length,
    reachable: results.filter((item) => item.verdict === "reachable").length,
    auth_or_waf: results.filter((item) => item.verdict === "auth_or_waf").length,
    manual: results.filter((item) => item.verdict === "manual").length,
    other: results.filter((item) => !["reachable", "auth_or_waf", "manual"].includes(item.verdict)).length
  },
  results
};
await writeFile(join(ROOT, "out/verification/signal-sources.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`\n可达 ${evidence.summary.reachable} / 需授权或反爬 ${evidence.summary.auth_or_waf} / 人工 ${evidence.summary.manual} / 其它 ${evidence.summary.other}`);
console.log("证据：out/verification/signal-sources.json");
