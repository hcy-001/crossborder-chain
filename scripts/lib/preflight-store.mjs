/**
 * 店铺 API A 档只读预检：把「包内属性能不能过平台审核」从人工过目变成机器对账。
 *
 * 边界（必须说清）：
 * - 只调读端点：/v1/description-category/attribute 与 .../attribute/values。写端点在这里不存在。
 * - 凭证只从环境变量或 --env 文件读，不落库、不打日志、不进回执。
 * - 字典核对是「值是否在官方字典里」的算术题：查不到就说查不到（含翻页上限），不猜近义词。
 */
const BASE = "https://api-seller.ozon.ru";

/** 读凭证：环境变量优先，其次 --env 指向的文件（KEY=VALUE 逐行）。缺哪项点名哪项。 */
export async function loadCredentials({env = process.env, envPath = null, readFileImpl = null} = {}) {
  let clientId = env.OZON_CLIENT_ID ?? null;
  let apiKey = env.OZON_API_KEY ?? null;
  let source = clientId && apiKey ? "environment" : null;
  if ((!clientId || !apiKey) && envPath) {
    if (typeof readFileImpl !== "function") throw new TypeError("envPath 需要 readFileImpl");
    const text = await readFileImpl(envPath, "utf8");
    const map = new Map();
    for (const line of String(text).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (match) map.set(match[1], match[2]);
    }
    clientId = clientId ?? map.get("OZON_CLIENT_ID") ?? null;
    apiKey = apiKey ?? map.get("OZON_API_KEY") ?? null;
    source = "env-file";
  }
  const missing = [!clientId && "OZON_CLIENT_ID", !apiKey && "OZON_API_KEY"].filter(Boolean);
  if (missing.length > 0) {
    const error = new Error(`凭证不全：缺 ${missing.join("、")}（环境变量或 --env 文件均可；没有凭证就无法预检，本脚本不造假）`);
    error.code = "CREDENTIALS_MISSING";
    throw error;
  }
  return {clientId, apiKey, source};
}

/** 平台 attributes.csv / master attributes.csv 统一按 canonical_key 列取值。 */
export function readAttributeCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return new Map();
  const headers = lines[0].split(",").map((header) => header.trim());
  const keyIndex = headers.indexOf("canonical_key") >= 0 ? headers.indexOf("canonical_key") : 0;
  const valueIndex = headers.indexOf("value") >= 0 ? headers.indexOf("value") : 1;
  const keys = new Map();
  for (const row of lines.slice(1)) {
    const cells = row.split(",");
    const key = (cells[keyIndex] ?? "").trim();
    if (key && !keys.has(key)) keys.set(key, (cells[valueIndex] ?? "").trim());
  }
  return keys;
}

const normalize = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * 预检主体。fetchImpl 可注入（测试用假 fetch，绝不联网）。
 * 返回 report；不抛业务失败（缺属性/字典查不到都是报告内容），只在上游配置不成立时抛 TypeError。
 */
export async function preflightStore({
  creds,
  fetchImpl,
  packageDir = null,
  packageAttributes = new Map(),
  sizeMappingValue = null,
  mapping,
  requiredAttributes = null,
  typeId = null,
  categoryId = null,
  language = "DEFAULT",
  pageSize = 1000,
  maxDictPages = 40,
  spacingMs = 220
} = {}) {
  if (!creds?.clientId || !creds?.apiKey) throw new TypeError("creds 必须含 clientId/apiKey");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须注入");
  if (!mapping?.category && !(typeId && categoryId)) throw new TypeError("mapping.category 或 typeId/categoryId 必须有其一");
  if (!packageDir && !(packageAttributes instanceof Map)) throw new TypeError("packageDir 或 packageAttributes 必须有其一");

  const resolvedTypeId = Number(typeId ?? mapping?.category?.type_id ?? 0);
  const resolvedCategoryId = Number(categoryId ?? mapping?.category?.description_category_id ?? 0);
  if (!resolvedTypeId || !resolvedCategoryId) throw new TypeError("type_id 与 description_category_id 都必须是正数");

  let lastCall = 0;
  const endpoints = [];
  const post = async (path, body) => {
    const wait = spacingMs - (Date.now() - lastCall);
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    lastCall = Date.now();
    endpoints.push(path);
    const response = await fetchImpl(`${BASE}${path}`, {
      method: "POST",
      headers: {"Client-Id": creds.clientId, "Api-Key": creds.apiKey, "Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${path} → HTTP ${response.status}：${text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(text);
  };

  // 1) 平台当前属性规则（live）：必填集合与字典 id 以平台此刻为准，不信任本地快照。
  const attributeResponse = await post("/v1/description-category/attribute", {
    description_category_id: resolvedCategoryId,
    type_id: resolvedTypeId,
    language
  });
  const liveAttributes = attributeResponse.result ?? [];
  const liveRequired = liveAttributes.filter((attribute) => attribute.is_required === true);

  // 2) 包内取值：与 check-attrs-coverage 同一套语义（映射键 → 别名 → 尺码映射）。
  const resolveValue = (attributeId) => {
    const entry = Object.entries(mapping.map ?? {}).find(([, meta]) => meta.attribute_id === attributeId);
    if (!entry) return {via: null, value: null, aliases: []};
    const [internal, meta] = entry;
    if (meta.source === "size-mapping.json") {
      return {via: `size-mapping:${internal}`, value: sizeMappingValue, aliases: [internal]};
    }
    const aliases = [internal, ...(meta.aliases ?? [])];
    const hit = aliases.map((key) => [key, packageAttributes.get(key)]).find(([, value]) => value && String(value).trim() !== "");
    return {via: hit ? `attributes.csv:${hit[0]}` : null, value: hit ? hit[1] : null, aliases};
  };

  // 3) 字典全量翻页（带上限）：返回值集合 + 实际扫了多少。
  const dictionaryCache = new Map();
  const loadDictionary = async (attributeId) => {
    if (dictionaryCache.has(attributeId)) return dictionaryCache.get(attributeId);
    const values = new Set();
    let lastValueId = 0;
    let pages = 0;
    let capped = false;
    while (pages < maxDictPages) {
      const page = await post("/v1/description-category/attribute/values", {
        attribute_id: attributeId,
        description_category_id: resolvedCategoryId,
        type_id: resolvedTypeId,
        language,
        last_value_id: lastValueId,
        limit: pageSize
      });
      const rows = page.result ?? [];
      for (const row of rows) {
        if (row?.value != null) values.add(normalize(row.value));
        if (row?.id != null) lastValueId = row.id;
      }
      pages += 1;
      if (page.has_next !== true || rows.length === 0) break;
      if (pages >= maxDictPages) capped = true;
    }
    const outcome = {values, pages, capped, scanned: values.size};
    dictionaryCache.set(attributeId, outcome);
    return outcome;
  };

  // 4) 逐必填项对账。
  const checks = [];
  for (const attribute of liveRequired) {
    const {via, value, aliases} = resolveValue(attribute.id);
    const check = {
      attribute_id: attribute.id,
      name: attribute.name,
      required: true,
      value: value ?? null,
      via,
      dictionary_id: Number(attribute.dictionary_id) > 0 ? attribute.dictionary_id : null,
      is_collection: attribute.is_collection === true
    };
    if (value == null || String(value).trim() === "") {
      check.status = "missing";
      check.detail = `包内没有值（内部键 ${aliases.join("/") || "无映射"}）`;
      checks.push(check);
      continue;
    }
    if (!check.dictionary_id) {
      check.status = "free_text";
      check.detail = "自由填属性，只查在不在，不查字典";
      checks.push(check);
      continue;
    }
    const dict = await loadDictionary(attribute.id);
    const parts = String(value).split(";").map((part) => normalize(part)).filter(Boolean);
    const missingParts = parts.filter((part) => !dict.values.has(part));
    if (missingParts.length === 0) {
      check.status = "in_dictionary";
      check.detail = `字典核对通过（翻页 ${dict.pages}，扫描 ${dict.scanned} 个值）`;
    } else if (dict.capped) {
      check.status = "cap_reached";
      check.detail = `翻到上限 ${maxDictPages} 页（扫描 ${dict.scanned} 个值）仍有未命中：${missingParts.join(", ")}`;
    } else {
      check.status = "not_found";
      check.detail = `字典里没有：${missingParts.join(", ")}（扫描 ${dict.scanned} 个值）——需要人工改用官方字典值`;
    }
    check.dictionary = {pages: dict.pages, scanned: dict.scanned, capped: dict.capped};
    checks.push(check);
  }

  const covered = checks.filter((check) => check.status !== "missing");
  const passed = checks.filter((check) => ["in_dictionary", "free_text"].includes(check.status));
  return {
    ran_at: new Date().toISOString(),
    platform: mapping?.platform ?? "ozon",
    readonly: true,
    category: {description_category_id: resolvedCategoryId, type_id: resolvedTypeId},
    package_dir: packageDir,
    totals: {
      required: checks.length,
      covered: covered.length,
      passed: passed.length,
      missing: checks.filter((check) => check.status === "missing").length,
      dictionary_failed: checks.filter((check) => ["not_found", "cap_reached"].includes(check.status)).length
    },
    checks,
    endpoints: [...new Set(endpoints)]
  };
}
