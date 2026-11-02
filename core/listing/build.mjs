/**
 * 上品信息组装。
 *
 * 这一层的定位：把「已成立的事实 + 已通过校验的判别」装成平台无关的输入，
 * 不做任何新的判断。凡是这里出现的值，都能回答「它来自哪」。
 *
 * 刻意不做的一件事：**不翻译**。产品类型的本地化写法必须来自目标市场的属性字典
 * 或模型给的 copy/title 判别；拿不到就原样留着并标 `title_status=untranslated`，
 * 绝不在这里塞一段「看起来像目标语言」的字符串。
 */

const REQUIRED_TITLE_KEYS = ["brand", "product_type", "key_attrs", "spec", "material", "audience"];

function pickAttribute(attributes, keys) {
  const hit = (attributes ?? []).find((row) => keys.includes(String(row.canonical_key ?? "").toLowerCase()));
  return hit ? String(hit.value ?? "") : "";
}

function factValue(facts, keys) {
  const hit = (facts ?? []).find((fact) => keys.includes(String(fact.key ?? "").toLowerCase()));
  return hit ? hit.value : null;
}

function titleTokens({attributes, facts, category, candidate, marketProfile, size}) {
  const tokens = {
    brand: pickAttribute(attributes, ["brand"]) || "NO BRAND",
    product_type: pickAttribute(attributes, ["product_type"]) || String(candidate?.title ?? category ?? "").slice(0, 60),
    key_attrs: (candidate?.design_elements ?? []).slice(0, 4).map(String),
    spec: size?.label ?? pickAttribute(attributes, ["size"]) ?? "",
    material: String(factValue(facts, ["material.composition", "material"]) ?? ""),
    audience: marketProfile?.age_band ? `age ${marketProfile.age_band}` : ""
  };
  const missing = REQUIRED_TITLE_KEYS.filter((key) => {
    const value = tokens[key];
    return Array.isArray(value) ? value.length === 0 : String(value ?? "").trim().length === 0;
  });
  return {tokens, missing};
}

function listingAttributes({attributes, facts, candidate, marketProfile}) {
  const rows = [];
  const push = (canonical_key, value, synonyms) => {
    if (value === null || value === undefined || String(value).trim() === "") return;
    rows.push({canonical_key, value, synonyms, confidence: "medium"});
  };
  push("brand", pickAttribute(attributes, ["brand"]) || "NO BRAND", "brand_name");
  push("product_type", pickAttribute(attributes, ["product_type"]) || candidate?.title, "product_name|category");
  push("color", pickAttribute(attributes, ["color"]) ?? factValue(facts, ["color", "colour"]), "color_name");
  push("size", pickAttribute(attributes, ["size"]), "size_name");
  push("material", factValue(facts, ["material.composition", "material"]), "composition|fabric");
  for (const item of attributes ?? []) {
    const key = String(item.canonical_key ?? "").toLowerCase();
    if (rows.some((row) => row.canonical_key === key)) continue;
    push(key, item.value, item.synonyms ?? "");
  }
  if (marketProfile?.palette) {
    push("palette_hint", marketProfile.palette.join(" / "), "market_palette");
  }
  return rows;
}

/**
 * @returns {{input: object, meta: object}} input 严格满足 product-input schema；
 * 任何「不足以支撑成品」的结论都放进 meta，不塞进 input（schema 不许额外字段）。
 */
export function buildListingInput({
  sku,
  destination,
  category,
  closeToSkin = false,
  isChild = false,
  productFacts = [],
  supplierFacts = [],
  attributes = [],
  platformMapping = null,
  copyPitch = null,
  marketProfile = null,
  platforms = [],
  candidate = null,
  size = null,
  variants = [],
  signalQuery = null,
  pricingFacts = [],
  persona = null,
  positioning = null,
  creativeBrief = null
}) {
  const facts = [...productFacts, ...supplierFacts].filter((fact) =>
    fact && typeof fact.key === "string" && fact.key.length > 0);

  const {tokens, missing} = titleTokens({attributes, facts, category, candidate, marketProfile, size});
  const listingAttrs = listingAttributes({attributes, facts, candidate, marketProfile});

  const copy = copyPitch
    ? {
      desc: String(copyPitch.desc ?? ""),
      bullets: Array.isArray(copyPitch.bullets) ? copyPitch.bullets.map(String) : [],
      keywords: Array.isArray(copyPitch.keywords) ? copyPitch.keywords.map(String) : []
    }
    : {desc: "", bullets: [], keywords: []};

  const input = {
    sku,
    destination,
    category: String(category ?? ""),
    close_to_skin: Boolean(closeToSkin),
    is_child: Boolean(isChild),
    facts,
    variants: Array.isArray(variants) ? variants : [],
    title_tokens: tokens,
    copy,
    attributes: listingAttrs,
    platforms: Array.isArray(platforms) ? platforms : [],
    pricing_facts: Array.isArray(pricingFacts) ? pricingFacts : []
  };
  if (size) input.size = size;
  if (signalQuery) input.signal_query = signalQuery;
  // 人群三件套只在有值时出现：没指派人群就不写空壳，避免下游把"空"读成"已确认没人"。
  if (persona) input.persona = persona;
  if (positioning) input.positioning = positioning;
  if (creativeBrief) input.creative_brief = creativeBrief;

  const meta = {
    sku,
    title_status: missing.length === 0 ? "complete" : "untranslated_or_missing",
    title_missing: missing,
    copy_status: copy.desc.trim().length > 0 ? "present" : "unavailable",
    copy_source: copyPitch ? "judge" : "none",
    attribute_count: listingAttrs.length,
    fact_count: facts.length,
    estimated_facts: facts.filter((fact) => fact.source_kind === "estimated").map((fact) => fact.key),
    reported_facts: facts.filter((fact) => fact.source_kind === "reported").map((fact) => fact.key),
    platform_spec_status: platformMapping?.spec_status ?? "missing",
    platform_title_limit: platformMapping?.title?.max_chars ?? null,
    market_profile: marketProfile?.profile_id ?? null,
    persona_id: persona?.id ?? "unassigned",
    persona_status: persona?.status ?? "unassigned",
    creative_brief_items: creativeBrief ? (creativeBrief.must_show ?? []).length : 0,
    pricing_facts: input.pricing_facts.length
  };

  return {input, meta};
}
