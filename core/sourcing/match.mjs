/**
 * 货源匹配结果 → 可用的事实。
 *
 * 三条纪律，每条都对应一个真实踩过的坑：
 * 1. 平台标价是「reported」不是「measured」—— 它没被下单验证过；
 * 2. 没有标价时只能估算，且必须带 basis 与 confidence，不许把估出来的数写成实价；
 * 3. 匹配不到主供就不产出成本事实 —— 宁可让定价不可用，也不许拿近似款的价格顶替。
 */

function normalizeOffer(offer, index) {
  return {
    ref: String(offer.ref ?? `ref-${String(index + 1).padStart(2, "0")}`),
    price_cny: Number.isFinite(Number(offer.price_cny)) ? Number(offer.price_cny) : null,
    moq: Number.isFinite(Number(offer.moq)) ? Number(offer.moq) : null,
    weight_g: Number.isFinite(Number(offer.weight_g)) ? Number(offer.weight_g) : null,
    sellers: Number.isFinite(Number(offer.sellers)) ? Number(offer.sellers) : null,
    url: typeof offer.url === "string" ? offer.url : null,
    fetched_at: typeof offer.fetched_at === "string" ? offer.fetched_at : null,
    title: typeof offer.title === "string" ? offer.title : null,
    flags: Array.isArray(offer.flags) ? offer.flags : []
  };
}

/**
 * @param {object} args
 * @param {Array} args.offers    货源搜索结果
 * @param {object} args.decision judge:sourcing_match 的决定（可为 null → 纯确定性路径）
 * @param {object} args.estimate judge:cost_estimate 的决定（可为 null）
 * @param {string} args.sku
 */
export function resolveSupplier({offers = [], decision = null, estimate = null, sku = "sku"} = {}) {
  const normalized = offers.map(normalizeOffer);
  const byRef = new Map(normalized.map((offer) => [offer.ref, offer]));

  const picked = decision?.picks ?? [];
  const heroPick = picked.find((pick) => pick.role === "hero") ?? null;
  const heroOffer = heroPick ? byRef.get(heroPick.ref) ?? null : null;

  const rejected = (decision?.rejected ?? []).map((item) => ({
    ref: item.ref,
    verdict: item.verdict,
    why: item.why
  }));

  if (!heroOffer) {
    return {
      status: "unavailable",
      reason: decision ? "no_hero_offer_in_search_results" : "no_match_decision_and_no_offers",
      sku,
      offers: normalized,
      facts: [],
      rejected
    };
  }

  const facts = [];
  const pricingFacts = [];
  const estimatedKeys = [];

  const pushPricingFact = (key, value, unit, url, fetchedAt) => {
    if (!url || !/^https:\/\//.test(url)) return;
    pricingFacts.push({
      key,
      value,
      unit,
      scope: {region: null, platform: null, category: null},
      source: "supplier_listing",
      source_url: url,
      source_type: "secondary",
      confidence: "secondary",
      status: "candidate",
      conflict_id: null,
      fetched_at: fetchedAt ?? new Date().toISOString(),
      ttl_hours: 168,
      stale: false,
      cross_check: [],
      divergence_pct: null,
      override: null
    });
  };

  if (heroOffer.price_cny !== null) {
    facts.push({
      key: "cost",
      value: heroOffer.price_cny,
      unit: "CNY",
      source_kind: "reported",
      basis: heroOffer.url
        ? `货源页标价（${heroOffer.ref}），未下单验证；来源链接见 pricing_facts`
        : `货源搜索结果标价（${heroOffer.ref}），无来源链接，可信度受限`,
      confidence: heroOffer.url ? "medium" : "low"
    });
    pushPricingFact("cost", heroOffer.price_cny, "CNY", heroOffer.url, heroOffer.fetched_at);
  } else if (estimate?.can_estimate === true && estimate.cost) {
    estimatedKeys.push("cost");
    facts.push({
      key: "cost",
      value: estimate.cost.value,
      unit: "CNY",
      source_kind: "estimated",
      basis: estimate.cost.basis,
      confidence: estimate.confidence ?? "low"
    });
  }

  if (heroOffer.weight_g !== null) {
    facts.push({
      key: "weight",
      value: heroOffer.weight_g,
      unit: "g",
      source_kind: "reported",
      basis: `货源页克重（${heroOffer.ref}），未实测`,
      confidence: "medium"
    });
    pushPricingFact("weight", heroOffer.weight_g, "g", heroOffer.url, heroOffer.fetched_at);
  } else if (estimate?.can_estimate === true && estimate.weight) {
    estimatedKeys.push("weight");
    facts.push({
      key: "weight",
      value: estimate.weight.value,
      unit: "g",
      source_kind: "estimated",
      basis: estimate.weight.basis,
      confidence: estimate.confidence ?? "low"
    });
  }

  const missing = ["cost", "weight"].filter((key) => !facts.some((fact) => fact.key === key));

  return {
    status: missing.length === 0 ? "complete" : "partial",
    reason: missing.length === 0 ? null : `missing_facts: ${missing.join(",")}`,
    sku,
    hero: heroOffer,
    offers: normalized,
    facts,
    pricing_facts: pricingFacts,
    estimated_keys: estimatedKeys,
    rejected,
    notes: [
      heroPick?.why ? `主供理由：${heroPick.why}` : null,
      missing.length > 0 ? "缺成本或克重时定价不可用，只出包不出价" : null
    ].filter(Boolean)
  };
}
