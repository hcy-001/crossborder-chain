/**
 * 地区时间维度：公共节假日 + 月均气温/降水。
 *
 * 为什么这两件事必须一起看：服装是"跟着天气和节日卖"的品类。
 * 不知道目标市场一年有几度、几月下雨、哪几天全民放假，排产与上新就只能靠猜。
 *
 * 两个源都免注册：
 *   - Nager.Date：公共假日（覆盖有限，没有的国家会明确报"无数据"，不编）
 *   - Open-Meteo：历史再分析（ERA5）日值，自己聚合成月均，避免二次加工失真
 */

export const defaultConfig = {
  id: "region-calendar",
  kind: "source",
  adapter: "nager+open-meteo",
  source_type: "official",
  requires: "none",
  enabled: true,
  ttl_hours: 8760
};

const NAGER = "https://date.nager.at/api/v3/PublicHolidays";
const METEO = "https://archive-api.open-meteo.com/v1/archive";

/**
 * @returns {Promise<{available: boolean, country: string, year: number, days: object[], note?: string, source_url: string}>}
 */
let coveredCountries = null;
/** 先问"这个国家收没收录"，再取数据。
 *  直接取 404 会返回空 body，判成"无假日"就把缺失伪装成了结论。 */
async function holidayCoverage(signal) {
  if (coveredCountries) return coveredCountries;
  const response = await fetch(`${NAGER.replace("/PublicHolidays", "")}/AvailableCountries`, {
    headers: {Accept: "application/json"},
    signal: signal ?? AbortSignal.timeout(20000)
  });
  if (!response.ok) return null;
  const payload = await response.json();
  coveredCountries = new Set(Array.isArray(payload) ? payload.map((item) => item.countryCode) : []);
  return coveredCountries;
}

export async function fetchHolidays({country, year, signal = null}) {
  const url = `${NAGER}/${year}/${country}`;
  const coverage = await holidayCoverage(signal);
  if (coverage && !coverage.has(country)) {
    return {
      available: false,
      country,
      year,
      days: [],
      note: "该库未收录这个国家（已核 AvailableCountries），须改用官方公报/央行假日表",
      source_url: url,
      coverage_checked: true
    };
  }
  const response = await fetch(url, {headers: {Accept: "application/json"}, signal: signal ?? AbortSignal.timeout(25000)});
  const body = await response.text();
  if (!response.ok || body.trim() === "") {
    return {
      available: false,
      country,
      year,
      days: [],
      note: `HTTP ${response.status}${body.trim() === "" ? "（空响应）" : ""}：可能限流或该年无数据，重跑或改用官方公报`,
      source_url: url,
      coverage_checked: Boolean(coverage)
    };
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return {available: false, country, year, days: [], note: "返回非 JSON", source_url: url};
  }
  if (!Array.isArray(payload)) {
    return {available: false, country, year, days: [], note: "返回结构异常", source_url: url};
  }
  return {
    available: payload.length > 0,
    country,
    year,
    days: payload.map((item) => ({
      date: item.date,
      name: item.name,
      local_name: item.localName ?? null,
      types: item.types ?? []
    })),
    note: payload.length === 0 ? "该年无记录" : null,
    source_url: url
  };
}

const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);

/**
 * @returns {Promise<{monthly_mean_c: (number|null)[], monthly_precip_mm: (number|null)[], annual_range_c: number|null, source_url: string}>}
 */
export async function fetchClimate({latitude, longitude, year, timezone, signal = null}) {
  const url = `${METEO}?latitude=${latitude}&longitude=${longitude}`
    + `&start_date=${year}-01-01&end_date=${year}-12-31`
    + `&daily=temperature_2m_mean,precipitation_sum&timezone=${encodeURIComponent(timezone)}`;
  const response = await fetch(url, {headers: {Accept: "application/json"}, signal: signal ?? AbortSignal.timeout(30000)});
  if (!response.ok) {
    throw Object.assign(new Error(`climate → HTTP ${response.status}`), {code: "HTTP_ERROR"});
  }
  const payload = await response.json();
  const dates = payload?.daily?.time ?? [];
  const temps = payload?.daily?.temperature_2m_mean ?? [];
  const precip = payload?.daily?.precipitation_sum ?? [];
  const byMonth = Array.from({length: 12}, () => ({temps: [], precip: []}));
  dates.forEach((date, index) => {
    const month = Number(String(date).slice(5, 7)) - 1;
    if (month < 0 || month > 11) return;
    if (Number.isFinite(temps[index])) byMonth[month].temps.push(temps[index]);
    if (Number.isFinite(precip[index])) byMonth[month].precip.push(precip[index]);
  });
  const monthlyTemp = byMonth.map((bucket) => {
    const value = mean(bucket.temps);
    return value === null ? null : Math.round(value * 10) / 10;
  });
  const monthlyPrecip = byMonth.map((bucket) => {
    const value = bucket.precip.length ? bucket.precip.reduce((sum, item) => sum + item, 0) : null;
    return value === null ? null : Math.round(value);
  });
  const valid = monthlyTemp.filter((value) => value !== null);
  return {
    monthly_mean_c: monthlyTemp,
    monthly_precip_mm: monthlyPrecip,
    annual_range_c: valid.length >= 10 ? Math.round((Math.max(...valid) - Math.min(...valid)) * 10) / 10 : null,
    source_url: url
  };
}
