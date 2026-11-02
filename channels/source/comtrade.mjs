/**
 * 品类规模：UN Comtrade 公开预览接口（免 key、免注册）。
 *
 * 为什么需要它：判断"这个市场值不值得进"，只看人均 GDP 是不够的 ——
 * 要看你这一类货在当地一年进口多少吨、多少钱，以及中国占多少份额。
 * 这三件事以前被标成"只有付费源"，实际 Comtrade 的公开接口就给了。
 *
 * 数据口径（必须随数字一起交付，否则会被误读）：
 *   - 这是**进口报关额**（CIF 或 FOB，按报告国口径），不是当地零售规模
 *   - 单位是美元与公斤；换算成"件"需要单件重量，属于估算，不许当实测
 *   - 年度数据有滞后（通常 1–2 年），period 必须写明
 */

export const defaultConfig = {
  id: "comtrade",
  kind: "source",
  adapter: "un-comtrade-preview",
  source_type: "official",
  requires: "none",
  enabled: true,
  ttl_hours: 8760
};

const BASE = "https://comtradeapi.un.org/public/v1/preview/C/A/HS";

/** ISO 国家码 → UN M49 数字码（Comtrade 用数字码）。 */
export const M49 = {
  SG: 702, MY: 458, TH: 764, PH: 608, ID: 360, VN: 704, AE: 784, SA: 682, RU: 643
};

/** 中国在 Comtrade 里的报告国码，用来算"中国份额"。 */
export const CHINA_M49 = 156;

/**
 * 女装相关 HS 编码（6 位）。
 * 只放与女装直接相关的：外套、连衣裙/裙/裤、衬衫、T恤、毛衫。
 * 不把 61/62 整章拉进来 —— 那会把男装与童装一起算进来，虚增规模。
 */
export const HS = {
  "6204": "女式西服套装、连衣裙、裙、裤（非针织）",
  "6104": "女式西服套装、连衣裙、裙、裤（针织）",
  "6202": "女式大衣、防风衣、雨衣（非针织）",
  "6206": "女式衬衫（非针织）",
  "6106": "女式衬衫（针织）",
  "6109": "T恤衫、背心（针织）",
  "6110": "毛衫、套头衫、开襟衫（针织）"
};

/**
 * @returns {Promise<{available: boolean, country: string, hs: string, hs_desc: string, year: number,
 *   import_value_usd: number|null, net_weight_kg: number|null, china_share_pct: number|null,
 *   unit_price_usd_per_kg: number|null, partners: object[], note: string|null, source_url: string}>}
 */
export async function fetchTrade({country, hs, year, signal = null}) {
  const reporter = M49[country];
  if (!reporter) throw Object.assign(new Error(`未登记 ${country} 的 M49 码`), {code: "COUNTRY_UNSUPPORTED"});
  if (!HS[hs]) throw Object.assign(new Error(`未登记 HS ${hs}`), {code: "HS_UNSUPPORTED"});
  const url = `${BASE}?reporterCode=${reporter}&period=${year}&cmdCode=${hs}&flowCode=M`;

  // 公开预览接口有速率限制（连发必 429）。这里做节流 + 退避重试：
  // 上报"取不到"之前必须先确认不是被限流挡的，否则会把限流说成"该国无数据"。
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 1500 * attempt));
    try {
      response = await fetch(url, {
        headers: {"User-Agent": "crossborder-delivery-skill/0.2", Accept: "application/json"},
        signal: signal ?? AbortSignal.timeout(35000)
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.status !== 429 && response.status < 500) break;
    lastError = Object.assign(new Error(`HTTP ${response.status}`), {status: response.status});
  }
  if (!response) {
    return {available: false, country, hs, hs_desc: HS[hs], year, import_value_usd: null, net_weight_kg: null, china_share_pct: null, unit_price_usd_per_kg: null, partners: [], note: `网络不可达：${lastError?.message ?? "unknown"}`, source_url: url};
  }
  if (!response.ok) {
    const hint = response.status === 429 ? "（限流：该接口约 1 次/秒，重跑即可）" : "";
    return {available: false, country, hs, hs_desc: HS[hs], year, import_value_usd: null, net_weight_kg: null, china_share_pct: null, unit_price_usd_per_kg: null, partners: [], note: `HTTP ${response.status}${hint}`, source_url: url};
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return {available: false, country, hs, hs_desc: HS[hs], year, import_value_usd: null, net_weight_kg: null, china_share_pct: null, unit_price_usd_per_kg: null, partners: [], note: "返回非 JSON", source_url: url};
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (rows.length === 0) {
    return {available: false, country, hs, hs_desc: HS[hs], year, import_value_usd: null, net_weight_kg: null, china_share_pct: null, unit_price_usd_per_kg: null, partners: [], note: payload?.error || "该年该编码无记录（可能未申报或编码变更）", source_url: url};
  }

  // partnerCode=0 是"World"汇总行；其余是分伙伴国。没有汇总行就自己加总，但要标出来。
  const world = rows.find((row) => Number(row.partnerCode) === 0);
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const totalValue = world && Number(world.primaryValue) > 0 ? Number(world.primaryValue) : sum("primaryValue");
  // World 行的净重经常是 0（报关金额有、重量缺），这时退回按伙伴国加总，别白丢单价。
  const worldWeight = world ? Number(world.netWgt) || 0 : 0;
  const totalWeight = worldWeight > 0 ? worldWeight : sum("netWgt");
  const china = rows.find((row) => Number(row.partnerCode) === CHINA_M49);
  const chinaValue = china ? Number(china.primaryValue) || 0 : null;

  const partners = rows
    .filter((row) => Number(row.partnerCode) !== 0)
    .map((row) => ({
      code: Number(row.partnerCode),
      name: row.partnerDesc ?? null,
      value_usd: Number(row.primaryValue) || 0,
      net_weight_kg: Number(row.netWgt) || 0
    }))
    .sort((left, right) => right.value_usd - left.value_usd)
    .slice(0, 8);

  return {
    available: totalValue > 0,
    country,
    hs,
    hs_desc: HS[hs],
    year,
    import_value_usd: totalValue > 0 ? Math.round(totalValue) : null,
    net_weight_kg: totalWeight > 0 ? Math.round(totalWeight) : null,
    china_share_pct: chinaValue !== null && totalValue > 0 ? Math.round((chinaValue / totalValue) * 1000) / 10 : null,
    unit_price_usd_per_kg: totalValue > 0 && totalWeight > 0 ? Math.round((totalValue / totalWeight) * 100) / 100 : null,
    partners,
    note: world ? null : "该接口未返回 World 汇总行，金额为分伙伴国加总（可能与官方汇总有细微差异）",
    source_url: url
  };
}
