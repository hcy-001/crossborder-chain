/**
 * 字典型属性的「值形态」判定。
 *
 * 为什么需要：覆盖率只回答"填了没有"，不回答"填了会不会被拒"。
 * 字典型属性（dictionary_id 非空）只接受字典里的项，自由文本一定被拒；
 * 但字典全量要写权限才能拉，所以在拉不到的前提下，只能先判形态 ——
 * 中文长串必拒，ASCII 短串可疑，西里尔文与纯数字放行。
 *
 * 本模块不含平台名与地区码：判定依据是"这个值是不是自然语言自由文本"，
 * 与具体平台无关。误报方向刻意保守（宁可多提示，不可假通过）。
 */

const CYRILLIC = /[\u0400-\u04ff]/;
const CJK_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const ASCII_TOKEN = /^[A-Za-z0-9 _\-.]+$/;
const NUMERIC = /^[\d.;,\s]+$/;
const NON_CURRENCY_UNIT = /%|g$|kg$|cm$|mm$|m$/;

/**
 * @param {{name?: string, dictionary_id?: number|null, value?: unknown}} item
 * @returns {null | {severity: "block"|"warn", code: string, detail: string}}
 */
export function checkDictionaryValueShape(item) {
  if (!item || !item.dictionary_id) return null;
  const text = String(item.value ?? "").trim();
  if (text === "") return null;
  if (CYRILLIC.test(text)) return null;
  if (NUMERIC.test(text)) return null;
  const label = `#${item.id ?? "?"} ${item.name ?? ""}`.trim();
  if (CJK_TEXT.test(text)) {
    return {
      severity: "block",
      code: "dictionary_value_cjk",
      detail: `${label} 是字典型（dictionary_id=${item.dictionary_id}），当前值是中文自由文本「${text.slice(0, 20)}${text.length > 20 ? "…" : ""}」—— 平台按字典校验，必拒`
    };
  }
  if (ASCII_TOKEN.test(text)) {
    return {
      severity: "warn",
      code: "dictionary_value_ascii",
      detail: `${label} 是字典型，当前值「${text}」是 ASCII 串 —— 需在后台确认它就是字典里的那一项`
    };
  }
  return {
    severity: "block",
    code: "dictionary_value_suspect",
    detail: `${label} 是字典型（dictionary_id=${item.dictionary_id}），当前值「${text.slice(0, 20)}」不在可预期的形态里`
  };
}

/** 只有"本该已是目标币"的金额项才参与币种核对。 */
export function isCurrencyLikeFact(fact) {
  if (!fact) return false;
  if (["cost", "weight"].includes(String(fact.key ?? ""))) return false;
  return !NON_CURRENCY_UNIT.test(String(fact.unit ?? ""));
}

/**
 * 字典成员校验：比"形态像不像"强一档 —— 直接问这个值在不在字典里。
 *
 * 字典是从官方接口拉全量后落盘的（data/dictionaries/<platform>/<attribute_id>.json），
 * 没拉过就不做成员判定，退回形态判定，绝不假装知道。
 *
 * @param {{name?: string, id?: number, value?: unknown, dictionary_id?: number|null}} item
 * @param {{values: {value: string}[]}|null} dictionary
 */
export function checkDictionaryMembership(item, dictionary) {
  if (!item || !item.dictionary_id) return null;
  if (!dictionary || !Array.isArray(dictionary.values) || dictionary.values.length === 0) return null;
  const text = String(item.value ?? "").trim();
  if (text === "") return null;

  const allowed = new Set(dictionary.values.map((entry) => String(entry.value)));
  // 集合型属性用分隔符串多个值，逐个校验；不拆开就会把 "44;46" 整体当成一个值。
  const parts = text.split(";").map((part) => part.trim()).filter(Boolean);
  const unknown = parts.filter((part) => !allowed.has(part));
  if (unknown.length === 0) return null;

  const label = `#${item.id ?? "?"} ${item.name ?? ""}`.trim();
  const preview = [...allowed].slice(0, 6).join(" / ");
  return {
    severity: "block",
    code: "dictionary_value_not_found",
    detail: `${label} 填的「${unknown.join("、")}」不在平台字典里（字典 ${dictionary.values.length} 项，例如：${preview}${allowed.size > 6 ? " …" : ""}）`
  };
}
