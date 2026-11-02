/**
 * 公共节假日：Google 官方公共假日日历（iCal），免注册、免 key、覆盖全球。
 *
 * 为什么要有这个源：Nager.Date 只收录部分国家（本项目的 9 个法域里缺 MY/TH/AE/SA 四国），
 * 而那四国恰好是东南亚与中东的主力市场。缺了假日，上新节奏与物流停摆就只能靠猜。
 * Google 的 "official holiday" 日历是各国政府公告的聚合，覆盖 9/9，且是机器可读的 iCal。
 *
 * 已知边界（必须写清，不能当全知）：
 *   - 它是"聚合源"，不是一手公告；关键档期（如斋月、黄金周）仍应对一次官方公报
 *   - 部分国家含 "regional holiday"（州级），是否影响全国物流需按国家判断
 *   - 日历包含历史年份，必须按年过滤，否则会把过去几年算进今年
 */

export const defaultConfig = {
  id: "google-holidays",
  kind: "source",
  adapter: "google-calendar-ical",
  source_type: "official-aggregator",
  requires: "none",
  enabled: true,
  ttl_hours: 8760
};

/** ISO 国家码 → Google 假日日历 ID 前缀。
 *  这些 ID 不能用规则拼（马来是 en.malaysia、泰国是 en.th、阿联酋是 en.ae），
 *  所以逐个实测确认后写死，并在 tests 里锁住。 */
export const CALENDAR_IDS = {
  SG: "en.singapore.official",
  MY: "en.malaysia.official",
  TH: "en.th",
  PH: "en.philippines.official",
  ID: "en.indonesian.official",
  VN: "en.vietnamese.official",
  AE: "en.ae",
  SA: "en.sa",
  RU: "en.russian.official"
};

const BASE = "https://calendar.google.com/calendar/ical";

export function calendarUrl(country) {
  const id = CALENDAR_IDS[country];
  if (!id) return null;
  return `${BASE}/${id}%23holiday%40group.v.calendar.google.com/public/basic.ics`;
}

/** iCal 会按 75 字节折行（续行以空格开头），先拼回去再解析，否则 SUMMARY 会被截断。 */
function unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function unescapeText(value) {
  return String(value ?? "")
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * 解析 iCal 文本，按年份筛出公共假日。
 * 只认全天事件（VALUE=DATE 或 8 位日期）：带时刻的多半是自定义提醒，不是公共假日。
 */
export function parseHolidayCalendar(raw, {year} = {}) {
  const text = unfold(raw);
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const days = [];
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const dateMatch = body.match(/DTSTART[^:]*:(\d{8})/);
    if (!dateMatch) continue;
    const raw8 = dateMatch[1];
    const date = `${raw8.slice(0, 4)}-${raw8.slice(4, 6)}-${raw8.slice(6, 8)}`;
    if (year && Number(raw8.slice(0, 4)) !== Number(year)) continue;
    const summary = unescapeText((body.match(/^SUMMARY:(.*)$/m) ?? [])[1]);
    if (!summary) continue;
    const description = unescapeText((body.match(/^DESCRIPTION:(.*)$/m) ?? [])[1]);
    days.push({
      date,
      name: summary,
      scope: /regional/i.test(summary) || /regional/i.test(description) ? "regional" : "national",
      kind: description || null
    });
  }
  // 同一天可能有多条（补假/重叠节），按日期+名称去重后排序
  const seen = new Set();
  return days
    .filter((day) => {
      const key = `${day.date}|${day.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * @returns {Promise<{available: boolean, country: string, year: number, days: object[],
 *   national_count: number, regional_count: number, note: string|null, source_url: string}>}
 */
export async function fetchHolidays({country, year, signal = null}) {
  const url = calendarUrl(country);
  if (!url) {
    return {
      available: false,
      country,
      year,
      days: [],
      national_count: 0,
      regional_count: 0,
      note: `未登记 ${country} 的日历 ID（见 CALENDAR_IDS）；不要用邻国假日顶替`,
      source_url: null
    };
  }
  let response;
  try {
    response = await fetch(url, {
      headers: {"User-Agent": "crossborder-delivery-skill/0.2", Accept: "text/calendar"},
      signal: signal ?? AbortSignal.timeout(30000)
    });
  } catch (error) {
    return {
      available: false,
      country,
      year,
      days: [],
      national_count: 0,
      regional_count: 0,
      note: `网络不可达：${error.message}`,
      source_url: url
    };
  }
  if (!response.ok) {
    return {
      available: false,
      country,
      year,
      days: [],
      national_count: 0,
      regional_count: 0,
      note: `HTTP ${response.status}：日历 ID 可能失效（Google 会返回 500 而不是 404）`,
      source_url: url
    };
  }
  const raw = await response.text();
  const days = parseHolidayCalendar(raw, {year});
  const national = days.filter((day) => day.scope === "national").length;
  return {
    available: days.length > 0,
    country,
    year,
    days,
    national_count: national,
    regional_count: days.length - national,
    note: days.length === 0 ? `日历可用但该年（${year}）没有事件：可能尚未发布下一年的表` : null,
    source_url: url
  };
}
