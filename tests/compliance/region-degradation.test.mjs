import test from "node:test";
import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {runPackage} from "../../scripts/lib/package-runner.mjs";
import {runDoctor} from "../../scripts/lib/preflight.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const nowIso = "2026-10-29T05:00:00.000Z";

async function fixture({dropPlatformSpecs = []} = {}) {
  const root = await mkdtemp(join(tmpdir(), "region-degradation-"));
  await Promise.all(["data", "regions", "schemas"].map((directory) =>
    cp(join(projectRoot, directory), join(root, directory), {recursive: true})
  ));
  await writeFile(join(root, "data/sources.json"), "[]\n");
  // 「平台事实缺失」要靠主动制造，不能靠某个平台恰好还没补 ——
  // 事实一补齐，测试就会自己失效，那是测试在跟着数据漂。
  for (const platform of dropPlatformSpecs) {
    await rm(join(root, "data/specs/platforms", `${platform}.json`), {force: true});
  }
  return root;
}

function withDestination(base, destination, platforms, sku) {
  return {
    ...base,
    sku,
    destination,
    platforms,
    copy: {
      ...base.copy,
      desc: "Placeholder copy for a region without verified compliance rules.",
      bullets: ["fixture for degradation behaviour"]
    }
  };
}

const offlineSignals = {
  run: async () => ({ok: false, signals: [], receipt: {status: "unavailable", detail: "fixture offline"}})
};

for (const [destination, platforms, currency] of [["SA", ["noon"], "SAR"], ["AE", ["noon"], "AED"]]) {
  test(`${destination} builds a package while every unverified fact stays unavailable`, async () => {
    const root = await fixture({dropPlatformSpecs: [platforms[0]]});
    const base = JSON.parse(await readFile(join(projectRoot, "input/demo-sku.json"), "utf8"));
    const sku = `${destination.toLowerCase()}-sku`;
    await cp(join(projectRoot, "input"), join(root, "input"), {recursive: true});
    await writeFile(join(root, "input", `${sku}.json`), JSON.stringify(withDestination(base, destination, platforms, sku), null, 2));

    const doctor = await runDoctor({root, nowIso});
    assert.equal(doctor.ok, true);
    assert.equal(doctor.state.pricing.status, "available", "RUB/CNY facts may exist while the destination currency is missing");

    const result = await runPackage({root, sku, nowIso, signalChannel: offlineSignals});
    const master = JSON.parse(await readFile(join(result.packageDir, "master/manifest.json"), "utf8"));
    const handoff = await readFile(join(result.packageDir, "handoff.md"), "utf8");
    const receipt = JSON.parse(await readFile(join(result.packageDir, "receipt.json"), "utf8"));
    const compliance = JSON.parse(await readFile(join(result.packageDir, "master/compliance/report.json"), "utf8"));
    const validate = JSON.parse(await readFile(join(result.packageDir, "platforms", platforms[0], "validate.json"), "utf8"));

    assert.equal(master.images.length, 9, "images must still be produced offline");
    assert.match(handoff.split(/\r?\n/)[0], /^BLOCKED:/);
    assert.match(handoff, /占位图/, "占位图提示必须在 handoff 里（位置可变，信息不能丢）");
    assert.deepEqual(compliance.blockers.length > 0, true, "missing region rules must surface as blockers");
    assert.match(compliance.notes, /unverified/);
    assert.equal(receipt.pricing.status, "unavailable", `${currency} must not be priced without cost and weight`);
    const pricingReasons = JSON.stringify(receipt.pricing.reasons);
    assert.ok(!pricingReasons.includes("fx_missing"), `${currency} now has an official FX source and must not report fx_missing`);
    assert.ok(receipt.pricing.reasons.length > 0, "an unavailable price must always explain why");
    assert.equal(validate.quality, "unverified");
    assert.equal(validate.violations[0].code, "spec_unavailable");
  });
}
