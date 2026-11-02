/**
 * 采集结果 → 候选品。
 *
 * 这一层只做归一与**确定性**的维度推导，不做判断。理由：
 * 打分要满足「同一输入两次逐字节一致」，任何一处夹带模型输出都会破这条。
 * 所以这里每个维度都写明它由哪个可观测量算出，拿不到就留 null 并在 basis 里说清楚。
 */

const clamp = (value, low = 0, high = 100) => Math.min(high, Math.max(low, value));

function quantile(values, ratio) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * 话题聚合：把「同一件东西」在不同来源里的条目并成一条。
 * 归并键刻意用 word 而不是标题 —— 标题各平台写法不同，词是共同最小单位。
 */
function groupByTopic(signals) {
  const groups = new Map();
  for (const signal of signals) {
    const key = String(signal.topic ?? signal.word ?? "").trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }
  return groups;
}

function recencyWeight(fetchedAt, now) {
  const fetched = Date.parse(fetchedAt ?? "");
  if (!Number.isFinite(fetched)) return 0.5;
  const days = Math.max(0, (now - fetched) / 86_400_000);
  return clamp(1 / (1 + days / 14), 0.05, 1);
}

/**
 * @param {object} args
 * @param {Array} args.signals 采集条目：{topic, word, mentions, engagement, fetched_at, source_url, source_type}
 * @param {Array} args.supply  供给观测：{topic, sellers, price_cny}
 * @param {number} args.now    评估时刻（毫秒），显式传入以便复现
 * @param {number} args.limit  产出上限
 */
export function buildCandidates({signals = [], supply = [], now = Date.now(), limit = 20} = {}) {
  const groups = groupByTopic(signals);
  const supplyByTopic = new Map();
  for (const item of supply) {
    const key = String(item.topic ?? "").trim().toLowerCase();
    if (!key) continue;
    const bucket = supplyByTopic.get(key) ?? {sellers: [], prices: []};
    if (Number.isFinite(item.sellers)) bucket.sellers.push(item.sellers);
    if (Number.isFinite(item.price_cny)) bucket.prices.push(item.price_cny);
    supplyByTopic.set(key, bucket);
  }

  const mentionTotals = [...groups.values()].map((rows) => rows.reduce((sum, row) => sum + (Number(row.mentions) ?? 0), 0));
  const maxMentions = Math.max(1, ...mentionTotals);
  const sellerCounts = [...supplyByTopic.values()].map((bucket) => Math.max(0, ...bucket.sellers));
  const maxSellers = Math.max(1, ...sellerCounts);
  const allPrices = [...supplyByTopic.values()].flatMap((bucket) => bucket.prices);
  const priceP20 = quantile(allPrices, 0.2);
  const priceP80 = quantile(allPrices, 0.8);

  const candidates = [];
  for (const [topic, rows] of groups) {
    const mentions = rows.reduce((sum, row) => sum + (Number(row.mentions) ?? 0), 0);
    const engagement = rows.reduce((sum, row) => sum + (Number(row.engagement) ?? 0), 0);
    const weighted = rows.reduce((sum, row) =>
      sum + (Number(row.mentions) ?? 0) * recencyWeight(row.fetched_at, now), 0);
    const bucket = supplyByTopic.get(topic) ?? {sellers: [], prices: []};
    const sellers = Math.max(0, ...bucket.sellers, 0);
    const medianPrice = quantile(bucket.prices, 0.5);

    const D = clamp((weighted / maxMentions) * 100);
    const G = clamp((1 - sellers / maxSellers) * 100);
    const C = clamp((sellers / maxSellers) * 100);
    const L = clamp((weighted / Math.max(1, mentions)) * 100);
    // 毛利只是价格带位置的代理量：没有成本就只能是代理，绝不写成真实毛利
    const M = medianPrice === null || priceP20 === null || priceP80 === null || priceP80 === priceP20
      ? null
      : clamp(((medianPrice - priceP20) / (priceP80 - priceP20)) * 100);

    candidates.push({
      id: topic.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `topic-${candidates.length + 1}`,
      title: rows[0]?.title ?? topic,
      topic,
      mentions,
      engagement,
      sellers,
      price_cny_median: medianPrice,
      dimensions: {
        D: Math.round(D * 10) / 10,
        G: Math.round(G * 10) / 10,
        M: M === null ? 0 : Math.round(M * 10) / 10,
        L: Math.round(L * 10) / 10,
        C: Math.round(C * 10) / 10
      },
      dimension_basis: {
        D: "近期加权提及量 / 全样本最大提及量 × 100",
        G: "1 − 卖家数 / 全样本最大卖家数，× 100",
        M: medianPrice === null ? "缺供给价格，按 0 处理且不计入决策依据" : "价带分位代理（非真实毛利）",
        L: "加权提及 / 原始提及，衡量热度新鲜度",
        C: "卖家数 / 全样本最大卖家数 × 100"
      },
      is_proxy: {M: medianPrice === null ? false : true},
      evidence: rows
        .filter((row) => row.source_url)
        .slice(0, 5)
        .map((row) => ({
          source_url: row.source_url,
          source_type: row.source_type ?? "secondary",
          fetched_at: row.fetched_at ?? null
        })),
      source_types: [...new Set(rows.map((row) => row.source_type ?? "secondary"))]
    });
  }

  return candidates
    .sort((left, right) => (right.mentions - left.mentions) || left.id.localeCompare(right.id))
    .slice(0, limit);
}
