#!/usr/bin/env node
/**
 * 评测集运行器：把「给定输入 → 产出应该长什么样」跑成可回归的结论。
 *
 * 与 `npm test` 的分工：
 *   test   —— 保证代码不坏（单测/契约/集成）
 *   evals  —— 保证产出对（业务口径：毛利、尺码、缺项是否点名）
 *
 * 用例是数据（evals/cases/*.json），加用例不用改代码。
 *
 * 用法：npm run evals
 */
import {readdir, readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {computePricing} from "../scripts/lib/chain-stages.mjs";
import {adaptSizeToPlatform} from "../core/sizing/adapt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES = join(ROOT, "evals", "cases");

const sizing = JSON.parse(await readFile(join(ROOT, "regions", "RU", "sizing.json"), "utf8"));

/** 每个用例按 id 前缀路由到对应的被测函数——路由表显式写出来，不做隐式猜测。 */
const RUNNERS = {
  pricing: (input) => computePricing(input),
  size: (input) => adaptSizeToPlatform({size: input.size, regionSizing: sizing, platform: "ozon"})
};

function pick(actual, expect) {
  const flat = {};
  if (expect.status !== undefined) flat.status = actual?.status;
  if (expect.reasons !== undefined) flat.reasons = actual?.reasons;
  if (expect.target_price_cny !== undefined) flat.target_price_cny = actual?.target?.breakdown?.price_cny;
  if (expect.profit_rate !== undefined) flat.profit_rate = actual?.target?.breakdown?.profit_rate;
  if (expect.commission_cny !== undefined) flat.commission_cny = actual?.target?.breakdown?.commission_cny;
  if (expect.attribute_value !== undefined) flat.attribute_value = actual?.payload?.attribute_value;
  if (expect.variant_mode !== undefined) flat.variant_mode = actual?.variant_strategy?.mode;
  return flat;
}

function close(a, b) {
  if (typeof b === "number") return typeof a === "number" && Math.abs(a - b) <= 0.05;
  if (Array.isArray(b)) return Array.isArray(a) && b.every((item) => a.includes(item));
  return a === b;
}

const files = (await readdir(CASES)).filter((name) => name.endsWith(".json")).sort();
let pass = 0;
const failures = [];

for (const file of files) {
  const testCase = JSON.parse(await readFile(join(CASES, file), "utf8"));
  const prefix = testCase.id.split("-")[0];
  const runner = RUNNERS[prefix];
  if (!runner) {
    failures.push({id: testCase.id, reason: `没有对应 runner（前缀 ${prefix}）`});
    continue;
  }
  const actual = await runner(testCase.input);
  const observed = pick(actual, testCase.expect);
  const bad = Object.entries(testCase.expect).filter(([key, value]) => !close(observed[key], value));
  if (bad.length === 0) {
    pass += 1;
    console.log(`✅ ${testCase.id} — ${testCase.what}`);
  } else {
    failures.push({id: testCase.id, bad: bad.map(([key, value]) => `${key}: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(observed[key])}`)});
    console.log(`❌ ${testCase.id} — ${testCase.what}`);
    for (const item of bad) console.log(`      ${item[0]}：期望 ${JSON.stringify(item[1])}，实际 ${JSON.stringify(observed[item[0]])}`);
  }
}

console.log(`\n${pass}/${files.length} 通过`);
if (failures.length > 0) {
  console.log("失败明细已在上方；评测不通过说明业务口径被改动，先确认是不是有意为之。");
  process.exit(1);
}
