import test from "node:test";
import assert from "node:assert/strict";
import {calculatePrice, diffPrices} from "../../core/pricing/calculate.mjs";

const product = {cost: 50, weight: 0.8};

function snapshot(components, snapshot_id = "snapshot-a") {
  return {
    snapshot_id,
    currency: "TARGET",
    fx: {value: 7, unit: "TARGET/SOURCE"},
    components
  };
}

test("calculatePrice excludes fx evidence, sums fee components once and sorts them by key", () => {
  const result = calculatePrice({
    product,
    snapshot: snapshot([
      {key: "shipping", local_value: 12},
      {key: "goods", local_value: 80},
      {key: "duties", local_value: 5}
    ]),
    roundTo: 2
  });

  assert.deepEqual(result, {
    status: "available",
    snapshot_id: "snapshot-a",
    currency: "TARGET",
    total: 97,
    components: [
      {key: "duties", local_value: 5},
      {key: "goods", local_value: 80},
      {key: "shipping", local_value: 12}
    ]
  });
});

test("independent valid fx evidence never changes the fee total", () => {
  const components = [
    {key: "goods", local_value: 80},
    {key: "shipping", local_value: 12}
  ];
  const lowFxSnapshot = snapshot(components);
  const highFxSnapshot = snapshot(components);
  lowFxSnapshot.fx.value = 0.01;
  highFxSnapshot.fx.value = 999999;

  const lowFxPrice = calculatePrice({product, snapshot: lowFxSnapshot, roundTo: 2});
  const highFxPrice = calculatePrice({product, snapshot: highFxSnapshot, roundTo: 2});
  assert.equal(lowFxPrice.status, "available");
  assert.equal(lowFxPrice.total, 92);
  assert.deepEqual(highFxPrice, lowFxPrice);
});

test("an fx component is rejected as misplaced and cannot affect the total", () => {
  const validPrice = calculatePrice({
    product,
    snapshot: snapshot([
      {key: "goods", local_value: 80},
      {key: "shipping", local_value: 12}
    ]),
    roundTo: 2
  });
  const misplacedPrice = calculatePrice({
    product,
    snapshot: snapshot([
      {key: "goods", local_value: 80},
      {key: "shipping", local_value: 12},
      {key: "fx", local_value: 1000}
    ]),
    roundTo: 2
  });

  assert.equal(validPrice.total, 92);
  assert.equal(misplacedPrice.status, "unavailable");
  assert.ok(misplacedPrice.reasons.includes("fx_misplaced"));
  assert.equal("total" in misplacedPrice, false);
});

test("missing or invalid cost and weight make pricing unavailable without throwing", () => {
  const invalidProducts = [
    {},
    {weight: 1},
    {cost: 1},
    {cost: 0, weight: 1},
    {cost: -1, weight: 1},
    {cost: Number.NaN, weight: 1},
    {cost: Number.POSITIVE_INFINITY, weight: 1},
    {cost: "50", weight: 1},
    {cost: 50, weight: 0},
    {cost: 50, weight: -0.5},
    {cost: 50, weight: Number.NaN},
    {cost: 50, weight: Number.POSITIVE_INFINITY},
    {cost: 50, weight: "0.8"}
  ];

  for (const invalidProduct of invalidProducts) {
    assert.doesNotThrow(() => calculatePrice({
      product: invalidProduct,
      snapshot: snapshot([{key: "goods", local_value: 10}]),
      roundTo: 2
    }));
    const result = calculatePrice({
      product: invalidProduct,
      snapshot: snapshot([{key: "goods", local_value: 10}]),
      roundTo: 2
    });
    assert.equal(result.status, "unavailable");
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.reasons.length > 0);
    assert.equal("total" in result, false);
  }

  assert.equal(calculatePrice({roundTo: 2}).status, "unavailable");
});

test("missing or invalid fx evidence makes pricing unavailable", () => {
  const withoutFx = snapshot([{key: "shipping", local_value: 10}]);
  delete withoutFx.fx;
  const missingFx = calculatePrice({product, snapshot: withoutFx, roundTo: 2});
  assert.deepEqual(missingFx, {status: "unavailable", reasons: ["fx_missing"]});

  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "7", null, undefined]) {
    const invalidSnapshot = snapshot([{key: "shipping", local_value: 10}]);
    invalidSnapshot.fx.value = value;
    const result = calculatePrice({product, snapshot: invalidSnapshot, roundTo: 2});
    assert.equal(result.status, "unavailable");
    assert.ok(result.reasons.includes("fx_invalid"));
    assert.equal("total" in result, false);
  }

  for (const unit of ["", "   ", null, undefined, 7]) {
    const invalidSnapshot = snapshot([{key: "shipping", local_value: 10}]);
    invalidSnapshot.fx.unit = unit;
    const result = calculatePrice({product, snapshot: invalidSnapshot, roundTo: 2});
    assert.equal(result.status, "unavailable");
    assert.ok(result.reasons.includes("fx_invalid"));
    assert.equal("total" in result, false);
  }

  const fxAsComponent = calculatePrice({
    product,
    snapshot: snapshot([{key: "fx", local_value: 10}]),
    roundTo: 2
  });
  assert.equal(fxAsComponent.status, "unavailable");
  assert.ok(fxAsComponent.reasons.includes("components_invalid"));
});

test("a non-finite component value is never replaced with a guess", () => {
  for (const local_value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "10", null, undefined]) {
    const result = calculatePrice({
      product,
      snapshot: snapshot([{key: "goods", local_value}]),
      roundTo: 2
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.reasons.includes("components_invalid"));
    assert.equal("total" in result, false);
  }

  const overflow = calculatePrice({
    product,
    snapshot: snapshot([
      {key: "goods", local_value: Number.MAX_VALUE},
      {key: "shipping", local_value: Number.MAX_VALUE}
    ]),
    roundTo: 2
  });
  assert.equal(overflow.status, "unavailable");
  assert.equal("total" in overflow, false);
});

test("the same snapshot produces byte-identical serialization on two runs", () => {
  const input = {
    product,
    snapshot: snapshot([
      {key: "shipping", local_value: 8.25},
      {key: "goods", local_value: 71.5},
      {key: "duties", local_value: 3.125}
    ]),
    roundTo: 3
  };
  const first = Buffer.from(`${JSON.stringify(calculatePrice(input), null, 2)}\n`);
  const second = Buffer.from(`${JSON.stringify(calculatePrice(structuredClone(input)), null, 2)}\n`);

  assert.ok(first.equals(second));
  assert.equal(JSON.parse(first.toString()).snapshot_id, "snapshot-a");
  assert.equal(JSON.stringify(calculatePrice(input)).includes("timestamp"), false);
});

test("roundTo rounds half up to the requested non-negative decimal places", () => {
  const components = [
    {key: "goods", local_value: 1.234},
    {key: "shipping", local_value: 2.345}
  ];
  assert.equal(calculatePrice({product, snapshot: snapshot(components), roundTo: 0}).total, 4);
  assert.equal(calculatePrice({product, snapshot: snapshot(components), roundTo: 2}).total, 3.58);
  assert.equal(calculatePrice({product, snapshot: snapshot(components), roundTo: 3}).total, 3.579);

  for (const roundTo of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
    const result = calculatePrice({product, snapshot: snapshot(components), roundTo});
    assert.equal(result.status, "unavailable");
    assert.ok(result.reasons.includes("roundTo_invalid"));
  }
});

test("diffPrices attributes changed, added and removed components and closes to the total delta", () => {
  const before = calculatePrice({
    product,
    snapshot: snapshot([
      {key: "shipping", local_value: 10},
      {key: "goods", local_value: 60},
      {key: "duties", local_value: 4}
    ], "snapshot-before"),
    roundTo: 2
  });
  const after = calculatePrice({
    product,
    snapshot: snapshot([
      {key: "packaging", local_value: 3},
      {key: "goods", local_value: 66},
      {key: "shipping", local_value: 12}
    ], "snapshot-after"),
    roundTo: 2
  });

  const diff = diffPrices(before, after);
  assert.equal(diff.total_delta, 7);
  assert.deepEqual(diff.attributions, [
    {key: "duties", before: 4, after: null, delta: -4},
    {key: "goods", before: 60, after: 66, delta: 6},
    {key: "packaging", before: null, after: 3, delta: 3},
    {key: "shipping", before: 10, after: 12, delta: 2}
  ]);
  assert.equal(diff.attribution_sum, 7);
  assert.equal(diff.closed, true);
});

test("diffPrices exposes a rounding gap instead of forcing closure", () => {
  const before = {
    status: "available",
    snapshot_id: "before",
    currency: "TARGET",
    total: 0,
    components: [{key: "goods", local_value: 0.004}]
  };
  const after = {
    status: "available",
    snapshot_id: "after",
    currency: "TARGET",
    total: 1,
    components: [{key: "goods", local_value: 0.006}]
  };
  const diff = diffPrices(before, after);

  assert.equal(diff.total_delta, 1);
  assert.equal(diff.attribution_sum, 0.002);
  assert.equal(diff.closed, false);
});
