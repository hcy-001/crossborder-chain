import assert from "node:assert/strict";
import test from "node:test";
import {mapDirection} from "../../scripts/market-scan.mjs";

test("方向词映射到品类码：开衫属于针织类 6110，不是机织的 6204", () => {
  // 这条是本项目的一个真实分界：开衫是针织（6110），连衣裙是机织（6204）。
  // 用错码，市场规模的量级会看错一个品类。
  const cardigan = mapDirection("女士针织开衫");
  assert.deepEqual(cardigan.codes, ["6110"]);
  assert.ok(cardigan.matched_by.includes("开衫"));

  const dress = mapDirection("连衣裙");
  assert.ok(dress.codes.includes("6204"), JSON.stringify(dress.codes));
});

test("同一个方向可以命中多个品类码，交给调用方按规模排序", () => {
  const pants = mapDirection("女式长裤");
  assert.ok(pants.codes.length >= 2, JSON.stringify(pants.codes));
});

test("俄语与英语的方向词同样能命中", () => {
  assert.deepEqual(mapDirection("кардиган").codes, ["6110"]);
  assert.deepEqual(mapDirection("cardigan").codes, ["6110"]);
});

test("匹配不到就返回空数组，不猜一个码顶上去", () => {
  const unknown = mapDirection("宠物雨衣");
  assert.deepEqual(unknown.codes, []);
  assert.deepEqual(unknown.matched_by, []);
});
