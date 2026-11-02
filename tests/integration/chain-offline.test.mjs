import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {cleanupQuietly, rmQuietly} from "../helpers/cleanup.mjs";
import {promisify} from "node:util";

const exec = promisify(execFile);
const repoRoot = resolve(".");

const baseTicket = {
  kind: "sourcing_ticket",
  schema_version: 1,
  candidate_id: "kw-юбка тест",
  slug: "iubka-test",
  keyword: "юбка тестовая",
  merge_attribute: "iubka-test",
  signal_date: "2026-10-01",
  trend_score: 77,
  evidence_level: "L1",
  decision: "observe",
  signals: {"S2-场景需求": 20, "S4-价格": 8, "S7-互动量": 4},
  design_elements: [{word: "плиссе", dim: "面料", total: 12}],
  offer_url: "https://detail.1688.com/offer/000000000001.html",
  price_cny: 55,
  weight_g: 320,
  composition: "Полиэстер 100%",
  cn_title: "测试用百褶半身裙",
  listed_hits: 3,
  size_chart: {columns: ["RU", "Обхват талии"]}
};

async function runChain(args) {
  try {
    const {stdout, stderr} = await exec(process.execPath, ["scripts/chain.mjs", ...args], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000
    });
    return {code: 0, stdout, stderr};
  } catch (error) {
    return {code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? ""};
  }
}

test("离线全链路：零 key、零网络、占位图，一次调用产出成品包与判别台账", async () => {
  const ticketDir = await mkdtemp(join(tmpdir(), "tickets-"));
  const stamp = Date.now().toString(36);
  const runId = `test-${stamp}`;
  // sku 由 slug 派生：slug 写死会让并行跑批互相覆盖 package/ 与 input/。
  // 每个测试实例用自己的 slug，保证隔离（全量并发跑时才不会偶发红）。
  const ticket = {...baseTicket, slug: `iubka-test-${stamp}`, merge_attribute: `iubka-test-${stamp}`};
  let receipt = null;
  try {
    await writeFile(join(ticketDir, "iubka-test.json"), `${JSON.stringify(ticket, null, 2)}\n`);
    const result = await runChain([
      "--category", "女装", "--region", "RU", "--candidates", "1",
      "--tickets", ticketDir,
      "--mock-llm", "--mock-images", "--run-id", runId
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    receipt = JSON.parse(await readFile(join(repoRoot, "runs", runId, "chain.receipt.json"), "utf8"));
    assert.equal(receipt.stage, "chain");
    assert.equal(receipt.inputs.candidates, 1);
    assert.equal(receipt.collect?.tickets_total ?? receipt.stages.collect.tickets_total, 1);
    assert.ok(receipt.judges.total >= 5, `判别次数应覆盖自检与主要判别点，实际 ${receipt.judges.total}`);
    assert.ok(receipt.judges.by_source.llm > 0, "桩通道也应当走 LLM 路径，以便与回退路径区分");
    assert.equal(receipt.stages.produce[0].package, "ok");
    assert.equal(receipt.stages.produce[0].modeling, "planned");

    // 七个判别点必须都有明确去向：llm / fallback / skipped_*，不许静默缺席
    const judged = receipt.stages.produce[0].judgments;
    for (const point of ["market_profile", "ref_roles", "shoot_plan", "cost_estimate", "platform_mapping", "copy_pitch"]) {
      assert.ok(judged[point], `判别点 ${point} 没有记录去向`);
      assert.match(String(judged[point]), /llm|fallback|skipped|deterministic|mock/);
    }

    const sku = receipt.stages.produce[0].sku;
    assert.match(sku, /^[a-z0-9][a-z0-9-]*$/);

    // 上品输入必须过 schema（chain 内部已校验，这里再从磁盘验一次）
    const input = JSON.parse(await readFile(join(repoRoot, "input", `${sku}.json`), "utf8"));
    assert.equal(input.destination, "RU");
    assert.equal(input.sku, sku);
    assert.ok(input.platforms.length > 0);
    assert.ok(input.attributes.some((row) => row.canonical_key === "material"));

    // 包：9 张图 + 平台投影 + 交接说明
    const images = (await readdir(join(repoRoot, "package", sku, "master", "images"))).filter((name) => name.endsWith(".png"));
    assert.equal(images.length, 9);
    const handoff = await readFile(join(repoRoot, "package", sku, "handoff.md"), "utf8");
    assert.match(handoff, /占位图|placeholder/);
    const platforms = await readdir(join(repoRoot, "package", sku, "platforms"));
    assert.ok(platforms.length >= 1);

    // 判别台账：每个点都能回放（含输入、原始返回、冲突与结论）
    const judgments = await readdir(join(repoRoot, "runs", runId, "judgments"));
    assert.ok(judgments.length >= 5, `判别台账条数 ${judgments.length}`);
    const one = JSON.parse(await readFile(join(repoRoot, "runs", runId, "judgments", judgments[0]), "utf8"));
    assert.ok(one.prompt_sha256);
    assert.ok(one.input);
    assert.equal(typeof one.accepted, "boolean");

    // 回执必须如实标注证据等级，不许把占位图写成真实出图
    assert.match(receipt.evidence_levels.images, /占位/);
    // 桩判别不是模型判断，等级写 L1
    assert.match(receipt.evidence_levels.llm_judgments, /^L1/);

    // 产物必须可定位：出包目录、图片张数、展陈渲染性质都要在回执里
    const produced = receipt.stages.produce[0];
    assert.ok(produced.package_dir, "回执要写出包目录");
    assert.equal(produced.images, 9);
    assert.equal(produced.modeling_kind, "exhibit_render");
    assert.equal(produced.product_in_scene, false);
    assert.match(produced.modeling_note, /商品本体不在场景内/);

    // 人群层：指派必须有证据，决策必须被 gate 记录，配额账必须写进回执
    assert.ok(produced.persona, "回执必须有 persona 段");
    assert.ok(["A", "B", "C", "unassigned"].includes(produced.persona.id));
    assert.ok(["hypothesis", "unassigned"].includes(produced.persona.status));
    if (produced.persona.id !== "unassigned") {
      assert.ok(produced.persona.evidence_ids.length > 0, "指派了人群就必须有证据编号");
    }
    assert.ok(["blocked", "reject", "unpriced", "observe", "test"].includes(produced.persona.decision));
    assert.equal(typeof receipt.persona_gate.quota_total, "number");
    assert.equal(typeof receipt.persona_gate.quota_used, "number");

    // 人群对下游的作用通道：指派成功时，上品输入必须带上三组字段
    const inputJson = JSON.parse(await readFile(join(repoRoot, "input", `${produced.sku}.json`), "utf8"));
    if (produced.persona.id !== "unassigned") {
      assert.equal(inputJson.persona.id, produced.persona.id);
      assert.ok(inputJson.positioning && inputJson.creative_brief);
      assert.ok(Array.isArray(inputJson.creative_brief.must_show));
    } else {
      assert.equal(inputJson.persona, undefined);
    }

    // 展陈渲染不等于商品三维：说 rendered 就得有渲染物
    if (produced.modeling === "rendered") {
      assert.ok(produced.modeling_files > 0, "rendered 必须给出渲染文件数");
    }
  } finally {
    if (receipt?.stages?.produce?.[0]?.sku) {
      const sku = receipt.stages.produce[0].sku;
      await cleanupQuietly(join(repoRoot, "package", sku));
      await cleanupQuietly(join(repoRoot, "assets", "3d", sku));
      await rmQuietly(join(repoRoot, "input", `${sku}.json`));
    }
    await cleanupQuietly(join(repoRoot, "runs", runId));
    await cleanupQuietly(ticketDir);
  }
});

test("空工单目录必须报错退出，不能用空候选冒充「市场没有机会」", async () => {
  const empty = await mkdtemp(join(tmpdir(), "tickets-empty-"));
  try {
    const result = await runChain([
      "--category", "女装", "--region", "RU", "--candidates", "1",
      "--tickets", empty, "--mock-llm", "--mock-images", "--run-id", `test-empty-${Date.now()}`
    ]);
    assert.equal(result.code, 2);
    assert.match(`${result.stderr}${result.stdout}`, /采集为空/);
  } finally {
    await rm(empty, {recursive: true, force: true});
  }
});

test("缺必填参数时给出用法并以 2 退出", async () => {
  const result = await runChain(["--category", "女装"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /缺少 --category 或 --region/);
});
