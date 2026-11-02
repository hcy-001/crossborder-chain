#!/usr/bin/env node
/**
 * noon 卖家帮助中心全量抓取。
 *
 * 为什么值得全量抓：noon 没有 API 文档站，规则散在几百篇帮助文章里。
 * 首页是 SPA 空壳，但文章页是服务端渲染 —— curl 就能拿到全文，不需要浏览器。
 * 所以正确的做法不是"找某一篇"，而是把 sitemap 里的文章全抓下来再检索。
 *
 * 用法：
 *   node scripts/probe-noon-help.mjs [--lang en] [--limit 0] [--offline]
 *
 * 产出：
 *   out/verification/official-docs/noon/raw/<slug>.txt   每篇正文
 *   out/verification/official-docs/noon/index.json      标题 + 长度 + 命中的关键词
 *
 * 纪律：
 *   - 1.2 秒/篇，不给对方站压力
 *   - 抓不到就记 failed，不重试超过 2 次
 *   - 只存正文文本，不存 HTML（省空间，也避免把脚本里的噪声存进去）
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};
const lang = String(flag("lang", "en"));
const limit = Number(flag("limit", "0")) || 0;
const offline = args.includes("--offline");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RAW_DIR = join(ROOT, "out", "verification", "official-docs", "noon", "raw");
const INDEX = join(ROOT, "out", "verification", "official-docs", "noon", "index.json");

/** 这些词命中即说明该文与"能不能上架"直接相关。 */
const KEYWORDS = [
  "character", "characters", "title", "image", "picture", "photo",
  "reject", "rejection", "attribute", "catalog", "sku", "size", "colour", "color",
  "commission", "referral", "fee", "vat", "warranty", "packaging", "barcode"
];

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: {"User-Agent": UA, Accept: "text/html"},
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) {
      if (attempt < 2 && response.status >= 500) {
        await new Promise((done) => setTimeout(done, 1200));
        return fetchText(url, attempt + 1);
      }
      return {ok: false, status: response.status, text: null};
    }
    return {ok: true, status: response.status, text: htmlToText(await response.text())};
  } catch (error) {
    if (attempt < 2) {
      await new Promise((done) => setTimeout(done, 1200));
      return fetchText(url, attempt + 1);
    }
    return {ok: false, status: 0, text: null, error: error.message};
  }
}

await mkdir(RAW_DIR, {recursive: true});

// sitemap 里同时有 /en/ 与 /ar/，只抓英文，避免重复一半流量
const sitemapPath = join(ROOT, "out", "verification", "official-docs", "noon", "sitemap.xml");
const sitemap = await readFile(sitemapPath, "utf8").catch(() => null);
if (!sitemap) {
  console.error(`缺 sitemap：${sitemapPath}\n先跑一遍：curl -s https://help.noon.partners/sitemap.xml -o "${sitemapPath}"`);
  process.exit(2);
}
const allUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const urls = allUrls.filter((url) => url.includes(`/${lang}/`));
const targets = limit > 0 ? urls.slice(0, limit) : urls;

console.log(`sitemap 共 ${allUrls.length} 条，/${lang}/ 共 ${urls.length} 条，本次抓 ${targets.length} 条`);

const index = [];
let done = 0;
let failed = 0;

if (!offline) {
  for (const url of targets) {
    const slug = url.split("/").pop() || `page-${done}`;
    const result = await fetchText(url);
    done += 1;
    if (!result.ok || !result.text) {
      failed += 1;
      index.push({slug, url, ok: false, status: result.status});
      if (failed <= 5) console.log(`  ✗ ${slug}（HTTP ${result.status}）`);
      continue;
    }
    const body = result.text.split("-->").pop().trim();
    await writeFile(join(RAW_DIR, `${slug}.txt`), `${body}\n`, "utf8");
    const lower = body.toLowerCase();
    const hits = KEYWORDS.filter((word) => lower.includes(word));
    index.push({slug, url, ok: true, chars: body.length, keywords: hits});
    if (done % 20 === 0) console.log(`  … ${done}/${targets.length}（失败 ${failed}）`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
  }
}

await writeFile(INDEX, `${JSON.stringify({lang, total: targets.length, done, failed, articles: index}, null, 2)}\n`, "utf8");

const withKeywords = index.filter((item) => item.ok && (item.keywords ?? []).length >= 3);
console.log(`\n抓完：成功 ${done - failed}，失败 ${failed}`);
console.log(`关键词命中 >=3 的文章：${withKeywords.length} 篇`);
console.log(`索引：${INDEX}`);
console.log(`正文目录：${RAW_DIR}`);

for (const item of withKeywords.sort((a, b) => b.keywords.length - a.keywords.length).slice(0, 15)) {
  console.log(`  ${String(item.keywords.length).padStart(2)} ${item.slug}（${item.chars} 字）`);
}

process.exit(failed > targets.length * 0.2 ? 1 : 0);
