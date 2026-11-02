function isPositiveFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function compareComponents(a, b) {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

function roundHalfUp(value, decimalPlaces) {
  const factor = 10 ** decimalPlaces;
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
  return Math.sign(value) * rounded;
}

export function calculatePrice(input = {}) {
  const product = input?.product;
  const snapshot = input?.snapshot;
  const roundTo = input?.roundTo;
  const reasons = [];

  if (!isPositiveFinite(product?.cost)) reasons.push("cost_invalid");
  if (!isPositiveFinite(product?.weight)) reasons.push("weight_invalid");
  if (!Number.isInteger(roundTo) || roundTo < 0) reasons.push("roundTo_invalid");

  const fx = snapshot?.fx;
  if (fx === null || fx === undefined) {
    reasons.push("fx_missing");
  } else if (!isPositiveFinite(fx.value) || typeof fx.unit !== "string" || fx.unit.trim().length === 0) {
    reasons.push("fx_invalid");
  }

  const components = snapshot?.components;
  if (Array.isArray(components) && components.some((component) => component?.key === "fx")) {
    reasons.push("fx_misplaced");
  }
  const componentsValid = Array.isArray(components) && components.every((component) =>
    component !== null && typeof component === "object" &&
    typeof component.key === "string" && component.key.length > 0 && component.key !== "fx" &&
    typeof component.local_value === "number" && Number.isFinite(component.local_value)
  );
  if (!componentsValid) reasons.push("components_invalid");

  const keys = componentsValid ? components.map((component) => component.key) : [];
  if (new Set(keys).size !== keys.length && !reasons.includes("components_invalid")) {
    reasons.push("components_invalid");
  }

  // 必填组件：跨境定价里最容易"被漏掉"的就是运费、佣金、税费、手续费。
  // 缺了它们算出来的不是"低价"，是"亏损价"。缺哪一项就指名道姓，不用行业均值补。
  const requiredComponents = Array.isArray(input?.requiredComponents) ? input.requiredComponents : [];
  if (componentsValid && requiredComponents.length > 0) {
    for (const key of requiredComponents) {
      if (!keys.includes(key)) reasons.push(`${key}_missing`);
    }
  }

  if (reasons.length > 0) return {status: "unavailable", reasons};

  const sortedComponents = components.map(({key, local_value}) => ({key, local_value}))
    .sort(compareComponents);
  const sum = sortedComponents.reduce((total, component) => total + component.local_value, 0);
  const total = roundHalfUp(sum, roundTo);
  if (!Number.isFinite(total)) return {status: "unavailable", reasons: ["total_invalid"]};

  return {
    status: "available",
    snapshot_id: snapshot.snapshot_id,
    currency: snapshot.currency,
    total,
    components: sortedComponents
  };
}

export function diffPrices(before, after) {
  const beforeComponents = new Map(before.components.map((component) => [component.key, component.local_value]));
  const afterComponents = new Map(after.components.map((component) => [component.key, component.local_value]));
  const keys = [...new Set([...beforeComponents.keys(), ...afterComponents.keys()])].sort();

  const attributions = keys.map((key) => {
    const beforeValue = beforeComponents.has(key) ? beforeComponents.get(key) : null;
    const afterValue = afterComponents.has(key) ? afterComponents.get(key) : null;
    return {
      key,
      before: beforeValue,
      after: afterValue,
      delta: (afterValue ?? 0) - (beforeValue ?? 0)
    };
  });
  const total_delta = after.total - before.total;
  const attribution_sum = attributions.reduce((sum, attribution) => sum + attribution.delta, 0);

  return {
    total_delta,
    attributions,
    attribution_sum,
    closed: Math.abs(attribution_sum - total_delta) <= 0.01
  };
}
