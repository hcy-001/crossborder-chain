#!/usr/bin/env node
/**
 * 1688 报价抓取：关键词 → 真实报价分布。
 *
 * 用法：
 *   node scripts/scan-1688-quotes.mjs --keyword "针织开衫 女 宽松"
 *   node scripts/scan-1688-quotes.mjs --keyword "针织开衫" --target-price 71.6
 *
 * 前提：本机 9222 调试端口有已登录 1688 的 Chrome。
 * 本脚本不登录、不猜验证码 —— 登录态归人，抓取归这里。
 *
 * ── 为什么要单人维护 9222 ──────────────────────────
 * 1688 的搜索结果要靠真实会话才拿得到；而搜索本身有频控，
 * 所以本脚本**只在 URL 完全一致时复用已有标签页**，否则新开一个，
 * 且跑完默认关掉自己开的那个，避免堆一堆 tab 增加风控暴露面。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CARD_EXTRACT_EXPRESSION,
  buildSearchUrl,
  encodeGbk,
  parseCards,
  summarizeQuotes
} from "../channels/source/ali1688.mjs";
import { closeTab, evaluate, listTabs, newTab, probeBrowser, waitFor } from "./lib/cdp-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return true;
  return value;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const keyword = flag("keyword");
  if (!keyword || keyword === true) {
    console.error('用法: node scripts/scan-1688-quotes.mjs --keyword "针织开衫 女 宽松" [--target-price 71.6] [--keep-tab]');
    process.exit(2);
  }

  const port = Number(flag("port", 9222));
  const targetPriceRaw = flag("target-price", null);
  const targetPrice = targetPriceRaw === null ? null : Number(targetPriceRaw);
  if (targetPriceRaw !== null && !Number.isFinite(targetPrice)) {
    console.error(`--target-price 不是数字：${targetPriceRaw}`);
    process.exit(2);
  }
  const keepTab = Boolean(flag("keep-tab", false));

  // ① 浏览器探活（只读）
  const browser = await probeBrowser({ port });
  if (!browser.available) {
    console.error(`浏览器不可用（端口 ${port}）：${browser.reason}`);
    console.error("本脚本不启停浏览器。请确认 9222 上的 Chrome 已登录 1688 后再跑。");
    process.exit(3);
  }

  // ② 拼 URL —— 关键词走 GBK，这一步错了后面全错
  const url = buildSearchUrl(String(keyword));
  console.log(`关键词：${keyword}`);
  console.log(`GBK query：${encodeGbk(String(keyword))}`);

  // ③ 只复用 URL 完全一致的标签页。URL 不同一律新开：
  //    停在旧结果页的 tab 会被 SPA 状态拖住，eval 全超时（历史踩过）。
  // 复用判定不能比整串 URL：页面自己会补 spm / 埋点参数，严格相等永远不成立，
  // 结果就是「每次都新开一次搜索」—— 白白多消耗搜索频次，增加风控暴露面。
  // 只比 keywords 参数值（已确定是 GBK 编码）即可。
  const keywordOf = (candidate) => {
    const matched = String(candidate ?? "").match(/[?&]keywords=([^&]*)/);
    return matched ? matched[1] : null;
  };
  const wanted = encodeGbk(String(keyword));
  const tabs = await listTabs({ port });
  const reusable = tabs.find((tab) => keywordOf(tab.url) === wanted);
  let tabId;
  let opened = false;
  if (reusable) {
    tabId = reusable.id;
    console.log(`复用已有标签页：${tabId}`);
  } else {
    const tab = await newTab(url, { port });
    tabId = tab.id;
    opened = true;
    console.log(`新开标签页：${tabId}`);
  }

  let exitCode = 0;
  try {
    // ④ 等结果。三种状态要分开报：风控 / 空结果 / 正常
    const state = await waitFor(
      tabId,
      `(() => {
        const text = document.body.innerText || '';
        if (/punish\\?x5secdata|滑动验证|请完成验证|安全验证/.test(location.href + ' ' + text)) return 'BLOCKED';
        if (document.querySelectorAll('a[href*="detail.1688.com/offer/"]').length > 0) return 'OK';
        if (/空空如也|没有找到|暂无相关/.test(text)) return 'EMPTY';
        return '';
      })()`,
      { port, timeout: 45000 }
    );

    if (state === "BLOCKED") {
      console.error("触发风控验证（滑块/安全验证）。这是平台侧策略，脚本不尝试绕。");
      console.error("处理：在 922 那个 Chrome 里人工完成验证后重跑；本次不做任何数据落盘。");
      exitCode = 4;
      return;
    }
    if (state === "EMPTY") {
      console.error("搜索结果为 0 条。可能原因：关键词太窄，或被静默降权。");
      console.error("先确认关键词本身在 1688 有货，再重试。不拿 0 条当「没有货源」。");
      exitCode = 5;
      return;
    }

    // ⑤ 提取
    const payload = await evaluate(tabId, CARD_EXTRACT_EXPRESSION, { port, timeout: 30000 });
    const { items } = parseCards(payload);
    if (items.length === 0) {
      console.error("页面有商品链接但一条都没解析出来 —— 卡片结构可能又变了。");
      console.error("先把页面 HTML 存下来看结构，不要改正则硬凑。");
      exitCode = 6;
      return;
    }

    const summary = summarizeQuotes(items, { targetPrice, keyword: String(keyword) });

    // ⑥ 落盘
    const outPath = flag("out", join(ROOT, "data", "market", `1688-quotes-${today()}.json`));
    await mkdir(dirname(outPath), { recursive: true });
    const doc = {
      channel: "ali1688-search",
      keyword: String(keyword),
      query_url: url,
      encoding: "gbk",
      fetched_at: new Date().toISOString(),
      browser_port: port,
      source_type: "official-marketplace",
      confidence: "measured",
      note: "报价为搜索列表页展示价（多为起批价或区间下限），不含运费、不含税、未含议价空间。"
        + "用于判断「能不能落到目标进价」，不能直接当成交价。",
      summary,
      items
    };
    await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

    // ⑦ 屏幕输出
    console.log("");
    console.log(`报价 ${summary.priced} 条（另有 ${summary.unpriced} 条未解析出价格）`);
    console.log(
      `  最低 ${summary.price.min} ｜ P25 ${summary.price.p25?.toFixed(1)} ｜ 中位 ${summary.price.median?.toFixed(1)}`
      + ` ｜ P75 ${summary.price.p75?.toFixed(1)} ｜ 最高 ${summary.price.max}`
    );
    if (summary.target_price !== null) {
      console.log(
        `  ≤ 目标进价 ${summary.target_price}：**${summary.under_target}/${summary.priced} 条（${summary.under_target_pct}%）**`
      );
      console.log(
        summary.under_target > 0
          ? `  → 结论：这个价能拿到货，且有 ${summary.under_target} 个可选供应商。`
          : "  → 结论：这个价拿不到货，需要抬价或改款。"
      );
    }
    if (summary.top_sellers.length > 0) {
      console.log("");
      console.log("成交量最高的几条（看需求是否真实）:");
      for (const item of summary.top_sellers) {
        console.log(`  ${String(item.sales).padStart(6)} 件 ｜ ${String(item.price_cny).padStart(6)} CNY ｜ ${item.title.slice(0, 34)}`);
      }
    }
    if (summary.cheapest.length > 0) {
      console.log("");
      console.log("最低价几条（看下限在哪）:");
      for (const item of summary.cheapest) {
        console.log(`  ${String(item.price_cny).padStart(6)} CNY ｜ ${item.title.slice(0, 34)} ｜ ${item.seller ?? "-"}`);
      }
    }
    console.log("");
    console.log(`落盘：${outPath}`);
  } finally {
    if (opened && !keepTab) {
      await closeTab(tabId, { port });
    } else if (opened) {
      console.log(`保留标签页：${tabId}`);
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`抓取失败：${error.message}`);
  process.exit(1);
});
