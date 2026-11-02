#!/usr/bin/env node
// G8/G9/G13 可复现证据：复用既有实现，不重写算法，只把「跑两遍是否一致」变成可复核产物。
// 用法：node scripts/evidence.mjs
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {scoreCategories} from "../core/signals/score.mjs";
import {calculatePrice, diffPrices} from "../core/pricing/calculate.mjs";
import * as labChannel from "../channels/storage/lab.mjs";

const root = resolve(process.cwd());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const checks = [];
const record = (id, ok, detail) => checks.push({id, ok, detail});

// G8：同输入双跑逐字节一致；改任一输入 input_sha256 改变
const scoreInput = {
  candidates: [
    {id: "cand-a", dimensions: {D: 72, G: 55, M: 80, L: 40, C: 65}},
    {id: "cand-b", dimensions: {D: 64, G: 70, M: 58, L: 75, C: 50}},
    {id: "cand-c", dimensions: {D: 58, G: 62, M: 66, L: 52, C: 74}}
  ]
};
const scoreRunOne = scoreCategories(scoreInput);
const scoreRunTwo = scoreCategories(scoreInput);
const scoreOneBytes = JSON.stringify(scoreRunOne);
const scoreTwoBytes = JSON.stringify(scoreRunTwo);
record("score_double_run_byte_identical", scoreOneBytes === scoreTwoBytes, {
  run_one_sha256: sha256(scoreOneBytes),
  run_two_sha256: sha256(scoreTwoBytes)
});
record("score_input_sha256_stable", scoreRunOne.input_sha256 === scoreRunTwo.input_sha256, scoreRunOne.input_sha256);

const mutatedInput = structuredClone(scoreInput);
mutatedInput.candidates[1].dimensions.D = 99;
const scoreMutated = scoreCategories(mutatedInput);
record("score_input_sha256_changes_on_input_change", scoreMutated.input_sha256 !== scoreRunOne.input_sha256, {
  original: scoreRunOne.input_sha256,
  mutated: scoreMutated.input_sha256
});
const changedRanking = scoreRunOne.rankings.aggressive[0].candidate_id !== scoreMutated.rankings.aggressive[0].candidate_id ||
  scoreRunOne.rankings.aggressive[0].score !== scoreMutated.rankings.aggressive[0].score;
record("score_ranking_reflects_input_change", changedRanking, {
  original_top: scoreRunOne.rankings.aggressive[0],
  mutated_top: scoreMutated.rankings.aggressive[0]
});

await mkdir(join(root, "out/P3"), {recursive: true});
await writeFile(join(root, "out/P3/score.json"), pretty({
  evidence: "G8 选品打分可复现",
  input_sha256: scoreRunOne.input_sha256,
  double_run: {
    run_one_sha256: sha256(scoreOneBytes),
    run_two_sha256: sha256(scoreTwoBytes),
    byte_identical: scoreOneBytes === scoreTwoBytes
  },
  mutated_input_sha256: scoreMutated.input_sha256,
  input: scoreInput,
  rankings: scoreRunOne.rankings,
  mutated_rankings: scoreMutated.rankings
}));

// G9：同快照双跑一致；换快照后归因和与总差额闭合，含新增/删除组件
const pricingInput = (components) => ({
  product: {cost: 3200, weight: 850},
  snapshot: {
    snapshot_id: "snap-before",
    currency: "RUB",
    fx: {value: 80.8664, unit: "RUB/USD"},
    components
  },
  roundTo: 2
});
const beforeInput = pricingInput([
  {key: "commission", local_value: 1200.5},
  {key: "logistics", local_value: 800.25},
  {key: "returns", local_value: 150}
]);
const afterInput = pricingInput([
  {key: "commission", local_value: 1500.5},
  {key: "acquiring", local_value: 300.75}
]);
const beforeOnce = calculatePrice(beforeInput);
const beforeTwice = calculatePrice(beforeInput);
const afterOnce = calculatePrice(afterInput);
record("pricing_double_run_identical", JSON.stringify(beforeOnce) === JSON.stringify(beforeTwice), beforeOnce.total);
record("pricing_available_for_valid_snapshot", beforeOnce.status === "available" && afterOnce.status === "available", {
  before: beforeOnce.total,
  after: afterOnce.total
});
const diff = diffPrices(beforeOnce, afterOnce);
record("pricing_attribution_closes_within_0_01", diff.closed === true && Math.abs(diff.attribution_sum - diff.total_delta) <= 0.01, {
  total_delta: diff.total_delta,
  attribution_sum: diff.attribution_sum,
  gap: Math.abs(diff.attribution_sum - diff.total_delta)
});
const removedKey = diff.attributions.find((item) => item.key === "logistics");
const addedKey = diff.attributions.find((item) => item.key === "acquiring");
record("pricing_attribution_covers_removed_and_added_components",
  removedKey?.after === null && addedKey?.before === null, {removed: removedKey, added: addedKey});

const fxAsComponent = calculatePrice(pricingInput([{key: "fx", local_value: 80.8664}, {key: "commission", local_value: 1200}]));
record("pricing_rejects_fx_inside_cost_components", fxAsComponent.status === "unavailable" && fxAsComponent.reasons.includes("fx_misplaced"), fxAsComponent.reasons);

await mkdir(join(root, "out/P1"), {recursive: true});
await writeFile(join(root, "out/P1/pricing.json"), pretty({
  evidence: "G9 定价与归因可复现，FX 只作证据不计入费用和",
  before: beforeOnce,
  after: afterOnce,
  before_double_run: {run_one: beforeOnce, run_two: beforeTwice, identical: JSON.stringify(beforeOnce) === JSON.stringify(beforeTwice)},
  diff,
  fx_guard: {result: fxAsComponent, note: "fx 出现在 components 中即判 fx_misplaced，汇率不进费用和"}
}));

// G13：内容寻址存储 —— 同内容同名，改内容改名
const storageRoot = await mkdtemp(join(tmpdir(), "lab-evidence-"));
const original = join(storageRoot, "original.png");
const sameCopy = join(storageRoot, "same-copy.png");
const changedCopy = join(storageRoot, "changed-copy.png");
const bytes = Buffer.from("placeholder-image-bytes-for-content-addressing");
await writeFile(original, bytes);
await writeFile(sameCopy, bytes);
await writeFile(changedCopy, Buffer.concat([bytes, Buffer.from("-changed")]));

const storeOne = await labChannel.run({files: [original], outputDir: join(storageRoot, "store-one")});
const storeTwo = await labChannel.run({files: [sameCopy], outputDir: join(storageRoot, "store-two")});
const storeThree = await labChannel.run({files: [changedCopy], outputDir: join(storageRoot, "store-three")});
const manifestOne = JSON.parse(await readFile(storeOne.meta.manifest, "utf8"));
const manifestTwo = JSON.parse(await readFile(storeTwo.meta.manifest, "utf8"));
const manifestThree = JSON.parse(await readFile(storeThree.meta.manifest, "utf8"));
record("storage_same_content_same_name", manifestOne.files[0].name === manifestTwo.files[0].name, {
  one: manifestOne.files[0].name,
  two: manifestTwo.files[0].name
});
record("storage_changed_content_changes_name_and_sha",
  manifestThree.files[0].name !== manifestOne.files[0].name &&
  manifestThree.files[0].sha256 !== manifestOne.files[0].sha256, {
    original: manifestOne.files[0],
    changed: manifestThree.files[0]
  });

await writeFile(join(root, "out/P3/storage.json"), pretty({
  evidence: "G13 内容寻址存储可复现",
  same_content: {original: manifestOne.files[0], repeated: manifestTwo.files[0], identical_name: manifestOne.files[0].name === manifestTwo.files[0].name},
  changed_content: {changed: manifestThree.files[0], renamed: manifestThree.files[0].name !== manifestOne.files[0].name},
  implementation: "channels/storage/lab.mjs（未改实现，仅调用）"
}));

const failed = checks.filter((check) => !check.ok);
const summary = {
  ok: failed.length === 0,
  generated_at: new Date().toISOString(),
  checks_total: checks.length,
  checks_failed: failed.length,
  failed: failed.map((check) => check.id),
  checks,
  artifacts: ["out/P3/score.json", "out/P1/pricing.json", "out/P3/storage.json"]
};
await writeFile(join(root, "out/verification/block3-evidence.json"), pretty(summary));
console.log(JSON.stringify(summary, null, 2));
if (failed.length > 0) process.exitCode = 1;
