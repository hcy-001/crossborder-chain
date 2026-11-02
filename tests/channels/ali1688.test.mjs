/**
 * 1688 报价通道的测试。
 *
 * 重点锁三件事，都是踩过的：
 * 1. 关键词必须编码成 GBK —— 用 UTF-8 会搜出无关商品，而页面看起来「有结果」
 * 2. 卡片解析要能吃「价格被换行拆成多段」的情形
 * 3. 分位数与「低于目标价的家数」必须是数出来的，不能是常量
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGbkTable,
  buildSearchUrl,
  encodeGbk,
  parseCards,
  summarizeQuotes
} from "../../channels/source/ali1688.mjs";

test("GBK 编码：现场向量逐字节一致（这条 URL 是人工搜出来验证过的）", () => {
  // 2026-11-02 在 922 的 Chrome 里手搜「针织，开衫」，地址栏是：
  //   ?keywords=%D5%EB%D6%AF%A3%AC%BF%AA%C9%C0&spm=...
  // 这段百分号串就是 1688 认可的编码形式，作为已知向量固定下来。
  assert.equal(encodeGbk("针织，开衫"), "%D5%EB%D6%AF%A3%AC%BF%AA%C9%C0");
  assert.equal(encodeGbk("针织开衫"), "%D5%EB%D6%AF%BF%AA%C9%C0");
});

test("GBK 编码：ASCII 走单字节，空格是 %20 而不是 +", () => {
  assert.equal(encodeGbk("a1"), "%61%31");
  assert.equal(encodeGbk(" "), "%20");
});

test("GBK 编码：绝不退化成 UTF-8", () => {
  const encoded = encodeGbk("针织开衫 女 宽松");
  // UTF-8 下「针」是 %E9%92%88。出现它就是搜出无关商品的根因
  assert.equal(encoded.includes("%E9%92%88"), false, `不该出现 UTF-8 字节：${encoded}`);
  assert.ok(encoded.startsWith("%D5%EB"), encoded);
});

test("GBK 编码：字符不在 GBK 里时抛错，不静默跳过", () => {
  assert.throws(() => encodeGbk("针织🎉"), /不在 GBK 字符集内/);
});

test("GBK 编码：建表规模与已知字符（防止表被改坏后仍「看起来能编码」）", () => {
  const table = buildGbkTable();
  assert.ok(table.size > 20000, `表只有 ${table.size} 个字符，明显不完整`);
  assert.deepEqual(table.get("针"), [0xd5, 0xeb]);
  assert.deepEqual(table.get("衫"), [0xc9, 0xc0]);
});

test("buildSearchUrl：关键词一定是 GBK，空关键词直接拒绝", () => {
  const url = buildSearchUrl("针织开衫");
  assert.ok(url.startsWith("https://s.1688.com/selloffer/offer_search.htm?keywords="));
  assert.ok(url.endsWith("%D5%EB%D6%AF%BF%AA%C9%C0"), url);
  assert.throws(() => buildSearchUrl("   "), /关键词不能为空/);
});

test("parseCards：容忍 CDP 返回前后的杂字符，取中间 JSON", () => {
  const payload = '### Result\n{"url":"https://s.1688.com/x","count":2,"items":[{"offer_id":"1"},{"offer_id":"2"}]}\n';
  const doc = parseCards(payload);
  assert.equal(doc.items.length, 2);
  assert.equal(doc.url, "https://s.1688.com/x");
});

test("parseCards：没有 JSON 时报错，不返回空数组假装成功", () => {
  assert.throws(() => parseCards("页面超时，无输出"), /找不到 JSON/);
});

const sample = [
  {offer_id: "a", price_cny: 20, sales: 100, title: "A", seller: "甲厂", url: "u1"},
  {offer_id: "b", price_cny: 30, sales: 9000, title: "B", seller: "乙厂", url: "u2"},
  {offer_id: "c", price_cny: 40, sales: null, title: "C", seller: "丙厂", url: "u3"},
  {offer_id: "d", price_cny: 80, sales: 500, title: "D", seller: "丁厂", url: "u4"},
  {offer_id: "e", price_cny: null, sales: null, title: "E（未解析出价）", seller: null, url: "u5"}
];

test("summarizeQuotes：分位数与有效样本数", () => {
  const summary = summarizeQuotes(sample);
  assert.equal(summary.total_cards, 5);
  assert.equal(summary.priced, 4, "价格为 null 的那条不能计入有效样本");
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.price.min, 20);
  assert.equal(summary.price.max, 80);
  assert.equal(summary.price.median, 35); // (30+40)/2
  assert.equal(summary.price.p25, 27.5); // 20 + (30-20)*0.75
});

test("summarizeQuotes：低于目标价的家数随目标价变化（不是常量）", () => {
  const low = summarizeQuotes(sample, {targetPrice: 25});
  const mid = summarizeQuotes(sample, {targetPrice: 45});
  const high = summarizeQuotes(sample, {targetPrice: 100});
  assert.equal(low.under_target, 1);
  assert.equal(mid.under_target, 3);
  assert.equal(high.under_target, 4);
  assert.equal(low.under_target_pct, 25);
  assert.equal(mid.under_target_pct, 75);
});

test("summarizeQuotes：不给目标价时不编造 under_target", () => {
  const summary = summarizeQuotes(sample);
  assert.equal(summary.target_price, null);
  assert.equal(summary.under_target, null);
  assert.equal(summary.under_target_pct, null);
});

test("summarizeQuotes：成交量排序不受价格顺序影响", () => {
  const summary = summarizeQuotes(sample, {targetPrice: 45});
  assert.equal(summary.top_sellers[0].offer_id, "b", "成交量最高的必须排第一");
  assert.equal(summary.cheapest[0].offer_id, "a", "最便宜的必须排第一");
});

// ── 机制：禁止再有人自己拼 1688 搜索 URL ──────────────────────
// 这条不是「测某个函数」，是扫仓库源码。因为踩过两次的都不是函数写错，
// 而是「顺手拼了个 URL」——函数测试拦不住新写的坏代码，只能扫全文。
test("仓库源码里不得用 encodeURIComponent 构造 1688 搜索 URL", async () => {
  const {readdir, readFile} = await import("node:fs/promises");
  const {join, dirname, resolve} = await import("node:path");
  const {fileURLToPath} = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  const offender = /offer_search\.htm\?keywords=[^\n]{0,50}encodeURIComponent/;
  const hits = [];
  for (const dir of ["channels", "scripts", "core", "adapters"]) {
    const files = await readdir(join(root, dir), {recursive: true}).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".mjs")) continue;
      const full = join(root, dir, file);
      const text = await readFile(full, "utf8").catch(() => "");
      if (offender.test(text)) hits.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `这些文件用 UTF-8 编码拼 1688 搜索 URL，会搜出无关商品：${hits.join(", ")}。改用 channels/source/ali1688.mjs 的 buildSearchUrl。`
  );
});
