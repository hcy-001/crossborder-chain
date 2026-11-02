/**
 * 1688 商品报价通道。
 *
 * ── 为什么这个文件存在 ────────────────────────────────
 * 1688 的搜索表单是 `acceptCharset=GBK`，服务器按 GBK 解码 query。
 * 用 `encodeURIComponent`（UTF-8）构造 URL 会得到两串完全不同的字节：
 *
 *   「针织，开衫」 GBK  → %D5%EB%D6%AF%A3%AC%BF%AA%C9%C0   ← 能搜到
 *   同一串 UTF-8      → %E9%92%88%E7%BB%87%EF%BC%8C%E5%BC%80%E8%A1%AB   ← 搜出无关商品或空结果
 *
 * 症状是「搜出宠物用品 / 页面空空如也」，看起来像解析器坏了或参数名变了，
 * 实际只是编码错了。这个坑在 2026-08 第一次用 CDP 抓 1688 时踩过，
 * 2026-11 又踩了一次 —— 所以编码逻辑收进这里，别处不许自己拼 URL。
 *
 * ── 硬约束 ────────────────────────────────────────────
 * 1. 本文件是 1688 搜索 URL 的**唯一真源**。禁止在别处出现 `offer_search.htm?keywords=`。
 * 2. 禁止用 `encodeURIComponent` 编码中文关键词。ASCII 部分可以，中文必须走 `encodeGbk`。
 * 3. 拿不到 GBK 编码就抛错，不许静默退回 UTF-8 —— 那会搜出无关商品却看着像成功。
 *
 * ── 编码表怎么来的 ────────────────────────────────────
 * Node 内置 `TextDecoder('gbk')` 只支持解码，没有编码器，也不带 iconv-lite。
 * 这里反过来用解码器建反查表：遍历 GBK 双字节空间（lead 0x81–0xFE × trail 0x40–0xFE），
 * 逐个解码，能解出单字符的就登记「字符 → 字节」。23,939 字、约 25ms，一次性缓存。
 */

const SEARCH_ENDPOINT = "https://s.1688.com/selloffer/offer_search.htm";

/** GBK 双字节反查表：字符 → [lead, trail]。首次调用时构建，之后复用。 */
let gbkTable = null;

/** 建表。导出的目的是让测试能直接校验表大小与已知字符。 */
export function buildGbkTable() {
  if (gbkTable) return gbkTable;
  const decoder = new TextDecoder("gbk");
  const table = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue; // GBK 未定义 0x7F
      const char = decoder.decode(Buffer.from([lead, trail]));
      // 只收「一个合法字符」：解出替换符 U+FFFD 或长度不为 1 的都是空位
      if (char.length === 1 && char !== "\uFFFD") table.set(char, [lead, trail]);
    }
  }
  gbkTable = table;
  return table;
}

/**
 * 把任意文本编码成 GBK 百分号形式，可直接拼进 query。
 *
 * ASCII 用一个字节；中文等双字节字符查表。表里没有就抛错 ——
 * 静默跳过会让关键词少几个字，搜出来的东西却「看起来有结果」。
 */
export function encodeGbk(text) {
  const table = buildGbkTable();
  const chunks = [];
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      chunks.push(`%${code.toString(16).toUpperCase().padStart(2, "0")}`);
      continue;
    }
    const bytes = table.get(char);
    if (!bytes) {
      throw new Error(
        `字符「${char}」(U+${code.toString(16).toUpperCase()}) 不在 GBK 字符集内，无法编码。`
        + "请改用 GBK 里存在的字，或换成英文关键词 —— 不要退回 UTF-8 编码。"
      );
    }
    chunks.push(`%${bytes[0].toString(16).toUpperCase().padStart(2, "0")}%${bytes[1].toString(16).toUpperCase().padStart(2, "0")}`);
  }
  return chunks.join("");
}

/** 拼搜索 URL。关键词走 GBK，其余走普通 encodeURIComponent（只有 ASCII）。 */
export function buildSearchUrl(keyword) {
  const kw = String(keyword ?? "").trim();
  if (!kw) throw new Error("关键词不能为空");
  return `${SEARCH_ENDPOINT}?keywords=${encodeGbk(kw)}`;
}

/**
 * 页面侧提取表达式。
 *
 * 踩过的坑：早期用 `innerText` 整体正则取价格，但卡片里 `¥` 与数字被换行拆开
 * （`¥ / 95 / .90` 三段），跨行正则匹配不到，于是误判成「选择器失效」。
 * 所以这里按行切分后再拼数字，并且以链接定位卡片而不是依赖带 hash 的类名
 * （类名形如 `offerCard--dMshu5T4`，hash 随构建变化）。
 *
 * 返回 JSON 字符串（CDP Runtime.evaluate 的 returnByValue 需要可序列化值）。
 */
export const CARD_EXTRACT_EXPRESSION = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="detail.1688.com/offer/"]')) {
    const href = a.getAttribute('href') || '';
    const matched = href.match(/offer\\/(\\d{8,})\\.html/);
    if (!matched) continue;
    const offerId = matched[1];
    if (seen.has(offerId)) continue;
    const card = a.closest('[class*="offerCard"],[class*="offer-card"],[class*="card-wrap"]') || a;
    const lines = (card.innerText || '').replace(/\\u00a0/g, ' ')
      .split('\\n').map((s) => s.trim()).filter(Boolean);
    const title = lines[0] || '';
    // 价格：找到 ¥ 之后最多两段纯数字，拼起来（处理 95 / .90 这种被拆开的情形）
    const yenAt = lines.indexOf('¥');
    let price = null;
    if (yenAt >= 0) {
      const digits = lines.slice(yenAt + 1, yenAt + 4).filter((s) => /^[\\d.]+$/.test(s));
      const value = parseFloat(digits.slice(0, 2).join(''));
      if (Number.isFinite(value)) price = value;
    }
    const salesText = lines.find((s) => /全网\\d+\\+?件|成交\\d+|已售\\d+/.test(s)) || null;
    const salesNum = salesText ? Number((salesText.match(/(\\d+)/) || [])[1]) : null;
    const moqText = lines.find((s) => /^\\d+\\s*(件|个|条|套|双)?\\s*起批/.test(s)) || null;
    const seller = lines.find((s) => /(厂|公司|商行|经营部|店)$/.test(s) && s.length <= 30) || null;
    const repurchase = lines.find((s) => /回头率\\s*\\d+%/.test(s)) || null;
    seen.add(offerId);
    out.push({
      offer_id: offerId,
      title: title.slice(0, 120),
      price_cny: price,
      sales_text: salesText,
      sales: Number.isFinite(salesNum) ? salesNum : null,
      moq_text: moqText,
      seller: seller,
      repurchase_text: repurchase,
      url: 'https://detail.1688.com/offer/' + offerId + '.html'
    });
  }
  return JSON.stringify({ url: location.href, count: out.length, items: out });
})()`;

/** 从 CDP 返回的字符串里取出结构。CDP 有时把结果包成 `"..."` 或带前缀输出。 */
export function parseCards(payload) {
  if (typeof payload !== "string") {
    throw new Error(`预期 CDP 返回字符串，实际 ${typeof payload}`);
  }
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`CDP 返回里找不到 JSON：${payload.slice(0, 200)}`);
  }
  const doc = JSON.parse(payload.slice(start, end + 1));
  return { url: doc.url ?? null, items: Array.isArray(doc.items) ? doc.items : [] };
}

/** 分位数（线性插值）。数组需已升序。 */
function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 报价统计。
 *
 * `target_price` 是可选的对照线：给定时算「有多少条报价低于目标进价」，
 * 这是「这个价能不能拿到货」的直接回答 —— 不是估算，是数出来的。
 */
export function summarizeQuotes(items, { targetPrice = null, keyword = null } = {}) {
  const valid = items.filter((item) => Number.isFinite(item.price_cny) && item.price_cny > 0);
  const prices = valid.map((item) => item.price_cny).sort((a, b) => a - b);
  const byPrice = [...valid].sort((a, b) => a.price_cny - b.price_cny);
  const cheapest = byPrice.slice(0, 5);
  const withSales = valid.filter((item) => Number.isFinite(item.sales) && item.sales > 0)
    .sort((a, b) => b.sales - a.sales);

  const underTarget = targetPrice === null
    ? null
    : valid.filter((item) => item.price_cny <= targetPrice).length;

  return {
    keyword,
    total_cards: items.length,
    priced: valid.length,
    unpriced: items.length - valid.length,
    price: {
      min: prices[0] ?? null,
      p25: quantile(prices, 0.25),
      median: quantile(prices, 0.5),
      p75: quantile(prices, 0.75),
      max: prices.at(-1) ?? null
    },
    target_price: targetPrice,
    under_target: underTarget,
    under_target_pct: underTarget === null || valid.length === 0
      ? null
      : Math.round((underTarget / valid.length) * 1000) / 10,
    cheapest: cheapest.map((item) => ({
      offer_id: item.offer_id,
      price_cny: item.price_cny,
      title: item.title,
      sales: item.sales,
      seller: item.seller,
      url: item.url
    })),
    top_sellers: withSales.slice(0, 5).map((item) => ({
      offer_id: item.offer_id,
      price_cny: item.price_cny,
      sales: item.sales,
      title: item.title,
      url: item.url
    }))
  };
}
