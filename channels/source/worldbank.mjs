/**
 * 地区底数通道：世界银行开放 API（无需 key、无需注册）。
 *
 * 为什么选它：9 个目标法域里有 8 个是新兴市场，平台侧销售数据不公开，
 * 但宏观底数（人口、人均 GDP、互联网渗透、城镇化、人均消费、女性劳动参与）
 * 是世界银行统一口径、每年更新的公开数据，可以一次拉全、交叉可比。
 *
 * 边界必须写清：这些是**国别需求侧底数**，不是平台销量，也不是品类规模。
 * 拿它做"该不该进这个市场"的初筛可以，拿它当"这个类目能卖多少"会错。
 */
const BASE = "https://api.worldbank.org/v2";

export const defaultConfig = {
  id: "worldbank-indicators",
  kind: "source",
  adapter: "worldbank",
  url: `${BASE}/country`,
  source_type: "official",
  requires: "none",
  enabled: true,
  ttl_hours: 8760,
  scope: {region: null, platform: null, category: null},
  capabilities: {format: "json", auth: "none"}
};

/** 指标口径集中在这里：加一个指标就多一行，不要在别处散着写代码。 */
export const INDICATORS = [
  {code: "SP.POP.TOTL", key: "region.population", unit: "person", label: "总人口"},
  {code: "NY.GDP.PCAP.CD", key: "region.gdp_per_capita", unit: "USD/person", label: "人均 GDP（现价美元）"},
  {code: "IT.NET.USER.ZS", key: "region.internet_users", unit: "%", label: "互联网使用率"},
  {code: "SP.URB.TOTL.IN.ZS", key: "region.urban_population", unit: "%", label: "城镇人口占比"},
  {code: "NE.CON.PRVT.PC.KD", key: "region.household_consumption_pc", unit: "constant 2015 USD/person", label: "人均家庭消费支出"},
  {code: "SL.TLF.CACT.FE.ZS", key: "region.female_labor_participation", unit: "%", label: "女性劳动参与率（15+）"}
];

/**
 * 一次拉一批国家的一个指标。
 * 世界银行的返回是 [meta, rows]，rows 里可能混着 null（该国该年无数据），必须逐条判空。
 */
export async function fetchIndicator({countries, indicator, year, signal = null, retries = 2}) {
  if (!Array.isArray(countries) || countries.length === 0) throw new Error("countries 不能为空");
  if (!/^[A-Z0-9.]+$/.test(String(indicator))) throw new Error(`指标代码不合法：${indicator}`);
  const url = `${BASE}/country/${countries.join(";")}/indicator/${indicator}?format=json&per_page=200&date=${year}`;
  let lastError = null;
  // 这个 API 会偶发超时（同一请求隔几秒就成功），一次失败就判"无数据"会把缺数留进产物里。
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {"User-Agent": "crossborder-delivery-skill/0.2", "Accept": "application/json"},
        signal: signal ?? AbortSignal.timeout(25000)
      });
      if (!response.ok) {
        throw Object.assign(new Error(`worldbank ${indicator} → HTTP ${response.status}`), {code: "HTTP_ERROR", status: response.status});
      }
      const payload = await response.json();
      const parsed = parseIndicator(payload);
      return {...parsed, indicator, year, source_url: url, attempts: attempt + 1};
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** 纯函数：把 [meta, rows] 变成 {last_updated, rows:[{iso3, country, year, value}]}。 */
export function parseIndicator(payload) {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw Object.assign(new Error("worldbank 返回结构异常"), {code: "BAD_PAYLOAD"});
  }
  const [meta, rows] = payload;
  if (rows === null) {
    throw Object.assign(new Error("worldbank 返回空数据集（可能是指标代码写错）"), {code: "NO_DATA"});
  }
  return {
    last_updated: meta?.lastupdated ?? null,
    rows: rows.map((row) => ({
      iso3: row?.countryiso3code ?? row?.country?.id ?? null,
      country: row?.country?.value ?? null,
      year: Number(row?.date) || null,
      value: row?.value === null || row?.value === undefined ? null : Number(row.value)
    }))
  };
}
