function matches(product, when = {}) {
  return Object.entries(when).every(([key, expected]) => {
    if (Array.isArray(expected)) {
      return expected.includes(product[key]);
    }
    return product[key] === expected;
  });
}

export function evaluateCompliance({rules, product, sku, destination, checkedAt}) {
  const items = rules.rules
    .filter((rule) => matches(product, rule.when))
    .map((rule) => ({
      layer: rule.layer,
      requirement: rule.requirement,
      applies_because: rule.applies_because,
      owner: rule.owner,
      status: rule.status ?? "required",
      source_url: rule.source_url,
      checked_at: checkedAt,
      confidence: rule.confidence
    }));

  return {
    sku,
    destination,
    items,
    blockers: items
      .filter((item) => item.status !== "provided")
      .map((item) => `待完成：${item.requirement}`),
    notes: rules.notes
  };
}
