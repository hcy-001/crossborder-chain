import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const facts = JSON.parse(await readFile(join(ROOT, "data/variables/fx.json"), "utf8"));
const requiredFields = JSON.parse(await readFile(join(ROOT, "schemas/fact.schema.json"), "utf8")).required;

const regions = ["RU", "SG", "MY", "TH", "PH", "ID", "VN", "AE", "SA"];

test("每个法域的结算币都必须有汇率事实，否则该法域算不出价", async () => {
  const missing = [];
  for (const region of regions) {
    const profile = JSON.parse(await readFile(join(ROOT, "regions", region, "profile.json"), "utf8"));
    const key = `fx.USD_${profile.currency}`;
    if (!facts.some((fact) => fact.key === key && Number.isFinite(fact.value))) {
      missing.push(`${region}（${profile.currency}）`);
    }
  }
  assert.deepEqual(missing, [], `这些法域缺汇率：${missing.join("、")}`);
});

test("汇率事实必须满足 fact schema 的必填字段（少一个 doctor 就拒绝启动）", () => {
  for (const fact of facts) {
    for (const field of requiredFields) {
      assert.ok(field in fact, `${fact.key} 缺 ${field}`);
    }
    assert.equal(fact.override, null);
  }
});

test("单源汇率不许伪装成已交叉核对", () => {
  for (const fact of facts) {
    const claimsCross = /已交叉核对/.test(String(fact.source));
    const hasCross = (fact.cross_check ?? []).length > 0;
    assert.equal(claimsCross, hasCross, `${fact.key} 的说明与交叉核对记录不一致`);
  }
});
