import assert from "node:assert/strict";
import test from "node:test";
import {marginAt, targetCost} from "../../scripts/source-lookup.mjs";

/**
 * 倒推与正算必须互逆。
 *
 * 踩过的坑：倒推用「余额 × (1−毛利率)」，正算用「毛利/售价」，
 * 两个口径不同 —— 倒推出 87.9 元进价，按这个价进货实际毛利只有 20.9%，不是设定的 30%。
 * 这类错不会报错，只会让人按错误的目标价去砍价，然后在结算时发现没钱赚。
 */

const A = {platform_commission_pct: 0.18, fulfillment_cny_per_order: 22, target_gross_margin_pct: 0.30};

test("倒推出的目标进价，代回复算必须正好等于设定的毛利", () => {
  for (const price of [120, 160, 180, 210, 480]) {
    const cost = targetCost({priceCny: price, assumptions: A});
    const margin = marginAt({priceCny: price, costCny: cost, assumptions: A});
    assert.equal(margin, 30, `售价 ${price}：倒推 ${cost} 元，复算毛利 ${margin}%，应为 30%`);
  }
});

test("进价高于目标价时毛利必然低于目标", () => {
  const price = 180;
  const cost = targetCost({priceCny: price, assumptions: A});
  const worse = marginAt({priceCny: price, costCny: cost + 10, assumptions: A});
  assert.ok(worse < 30, `进价高 10 元，毛利应低于 30%，实际 ${worse}%`);
});

test("售价覆盖不了佣金与履约时，目标进价为 0 而不是负数", () => {
  const cost = targetCost({priceCny: 20, assumptions: A});
  assert.equal(cost, 0, "低价商品不该倒推出负的采购价");
  assert.ok(marginAt({priceCny: 20, costCny: 0, assumptions: A}) < 0, "此时本来就做不出 30% 毛利，应显负");
});

test("缺售价时返回 null，不用 0 或猜测值顶上", () => {
  assert.equal(targetCost({priceCny: null}), null);
  assert.equal(targetCost({priceCny: undefined}), null);
  assert.equal(marginAt({priceCny: null, costCny: 50}), null);
});
