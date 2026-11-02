import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {adaptSizeToPlatform} from "../../core/sizing/adapt.mjs";
import {evaluateHeight, evaluateSizeValues} from "../../core/sizing/rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const regionSizing = JSON.parse(await readFile(join(ROOT, "regions/RU/sizing.json"), "utf8"));
const rules = regionSizing.size_value_rules;

test("配置里的尺码值规则必须带官方出处，否则后面全是猜的", () => {
  assert.equal(rules.status, "final");
  assert.equal(rules.source_type, "official");
  assert.match(rules.source_url, /^https:\/\/global-help\.ozon\.com\//);
  assert.ok(rules.evidence.length >= 4, "每条规则都要能追到官方原文");
});

test("两个连续码用分号串起来，展示为区间", () => {
  const result = evaluateSizeValues(["42", "44"], rules);
  assert.equal(result.value, "42;44");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.violations, []);
});

test("三个不连续码照原样串，不擅自补中间码", () => {
  const result = evaluateSizeValues(["50", "52", "54"], rules);
  assert.equal(result.value, "50;52;54");
  assert.equal(result.status, "ok");
});

test("4 个及以上连续尺码折叠成字典项 универсальный（官方字典实拉确认）", () => {
  const result = evaluateSizeValues(["42", "44", "46", "48"], rules);
  assert.equal(result.value, "универсальный");
  assert.equal(result.status, "collapsed");
  assert.ok(result.applied.some((text) => text.includes("连续 4")));
});

test("恰好 3 个连续码仍逐个填，不提前折叠", () => {
  const result = evaluateSizeValues(["42", "44", "46"], rules);
  assert.equal(result.value, "42;44;46");
  assert.equal(result.status, "ok");
});

test("奇数码违反步长 2，必须报出来而不是静默通过", () => {
  const result = evaluateSizeValues(["43", "45"], rules);
  assert.equal(result.status, "invalid");
  assert.equal(result.violations.filter((item) => item.code === "size_step").length, 2);
});

test("超出成人码区间的值报 size_range", () => {
  const result = evaluateSizeValues(["32", "88"], rules);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("size_range"));
});

test("非数字尺码不做算术判定，但要留人工复核钩子", () => {
  const result = evaluateSizeValues(["XL", "XXL"], rules);
  assert.equal(result.value, "XL;XXL");
  assert.equal(result.status, "non_numeric");
  assert.equal(result.actions.length, 1);
});

test("没登记规则的法域退回旧行为，并标明未校验", () => {
  const result = evaluateSizeValues(["42", "44"], null);
  assert.equal(result.value, "42;44");
  assert.equal(result.status, "unchecked");
});

test("身高超出 152–194 要报出来", () => {
  const bad = evaluateHeight("170", rules);
  assert.equal(bad.ok, true);
  const result = evaluateHeight("200", rules);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, "height_range");
});

test("映射层：4 个连续码直接给折叠值，状态 ready", () => {
  const size = {
    status: "reported",
    label: "RUS",
    unit: "см",
    columns: ["Российский размер"],
    rows: {"42": [], "44": [], "46": [], "48": []}
  };
  const result = adaptSizeToPlatform({size, regionSizing, platform: "ozon"});
  assert.equal(result.payload.attribute_value, "универсальный");
  assert.equal(result.status, "ready");
  assert.deepEqual(result.missing, []);
  assert.ok(result.notes.some((text) => text.includes("通用")));
});

test("映射层：合规两码照常出值，且留下判定痕迹", () => {
  const size = {
    status: "reported",
    label: "RUS",
    unit: "см",
    columns: ["Российский размер"],
    rows: {"44": [], "46": []}
  };
  const result = adaptSizeToPlatform({size, regionSizing, platform: "ozon"});
  assert.equal(result.payload.attribute_value, "44;46");
  assert.equal(result.status, "ready");
  assert.equal(result.payload.size_value_check.status, "ok");
});
