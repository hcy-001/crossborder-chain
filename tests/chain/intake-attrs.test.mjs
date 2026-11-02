import assert from "node:assert/strict";
import test from "node:test";
import {mergeIntakeAttributes, ticketAttributes} from "../../scripts/lib/chain-stages.mjs";

const ticket = {
  slug: "kurtka-test",
  name: "夹克",
  cn_title: "куртка женская",
  brand: "无品牌"
};

test("工单缺颜色/性别时，问卷补上并标来源", () => {
  const rows = mergeIntakeAttributes(ticketAttributes(ticket), {color: "хаки", gender: "Женский"});
  const color = rows.find((row) => row.canonical_key === "color");
  const audience = rows.find((row) => row.canonical_key === "audience");
  assert.equal(color.value, "хаки");
  assert.equal(color.source, "intake");
  assert.equal(audience.value, "Женский");
});

test("问卷答 unknown 视为没答，不覆盖工单已有值", () => {
  const withColor = ticketAttributes({...ticket, specs: [{color: "белый"}]});
  const rows = mergeIntakeAttributes(withColor, {color: "unknown", gender: "unknown"});
  assert.equal(rows.find((row) => row.canonical_key === "color").value, "белый");
  assert.equal(rows.some((row) => row.canonical_key === "audience"), false);
});

test("问卷答了就以问卷为准（用户说的比二手采集新）", () => {
  const withColor = ticketAttributes({...ticket, specs: [{color: "белый"}]});
  const rows = mergeIntakeAttributes(withColor, {color: "чёрный"});
  assert.equal(rows.find((row) => row.canonical_key === "color").value, "чёрный");
});

test("没有问卷时原样返回，不塞空壳", () => {
  const base = ticketAttributes(ticket);
  assert.deepEqual(mergeIntakeAttributes(base, null), base);
});

test("不改入参：合并产生新数组，工单原数组不受影响", () => {
  const base = ticketAttributes(ticket);
  const before = JSON.stringify(base);
  mergeIntakeAttributes(base, {color: "хаки"});
  assert.equal(JSON.stringify(base), before);
});
