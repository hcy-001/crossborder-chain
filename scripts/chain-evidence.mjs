#!/usr/bin/env node
/**
 * 把一次真实链路运行压成交付证据：不重新调用模型、不重新生成图，
 * 只从「判别台账 + 链路回执 + 出包清单」三份既有产物里读数，
 * 避免证据与实跑脱钩（口径：证据只能转录产物，不能重算结论）。
 *
 * 用法：node scripts/chain-evidence.mjs --run <run_id> [--out out/verification]
 */
import {readdir, readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const runId = flag("run");
if (!runId) {
  console.error("用法：node scripts/chain-evidence.mjs --run <run_id> [--out <dir>]");
  process.exit(2);
}
const outDir = resolve(ROOT, flag("out", "out/verification"));
const runDir = join(ROOT, "runs", runId);

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const receipt = await readJson(join(runDir, "chain.receipt.json"));

const journalDir = join(runDir, "judgments");
const journalFiles = (await readdir(journalDir).catch(() => [])).filter((name) => name.endsWith(".json"));
const judgments = [];
for (const name of journalFiles.sort()) {
  const entry = await readJson(join(journalDir, name));
  judgments.push({
    point: entry.point,
    scope: entry.scope,
    source: entry.source,
    accepted: entry.accepted,
    confidence: entry.confidence ?? entry.parsed?.confidence ?? null,
    parse_layer: entry.parse_layer,
    attempts: entry.attempts,
    latency_ms: entry.latency_ms,
    total_tokens: entry.usage?.total_tokens ?? null,
    reasoning_tokens: entry.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    reject_reason: entry.reject_reason
  });
}

const images = [];
const modeling = [];
for (const item of receipt.stages?.produce ?? []) {
  modeling.push({sku: item.sku, status: item.modeling, dir: item.modeling_dir, files: item.modeling_files ?? 0});
  if (!item.package_dir) continue;
  const manifest = await readJson(join(item.package_dir, "master/manifest.json")).catch(() => null);
  for (const image of manifest?.images ?? []) {
    images.push({
      sku: item.sku,
      file: image.file,
      role: image.role,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
      quality: image.quality
    });
  }
}

const tokens = receipt.judges?.usage ?? {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0};
const evidence = {
  run_id: runId,
  generated_at: new Date().toISOString(),
  duration_ms: receipt.duration_ms,
  inputs: receipt.inputs,
  status: receipt.status,
  judgments: {
    total: receipt.judges?.total ?? 0,
    by_source: receipt.judges?.by_source ?? {},
    total_tokens: tokens.total_tokens,
    entries: judgments
  },
  degradations: receipt.degradations ?? [],
  persona_gate: receipt.persona_gate ?? null,
  personas: (receipt.stages?.produce ?? []).map((item) => ({sku: item.sku, ...(item.persona ?? {})})),
  evidence_levels: receipt.evidence_levels ?? {},
  images: {count: images.length, items: images},
  modeling,
  verdicts: {
    llm_judged_all: (receipt.judges?.total ?? 0) > 0 && (receipt.judges?.by_source?.fallback ?? 0) === 0,
    images_real: images.length > 0 && images.every((image) => image.quality === "generated"),
    sizes_ok: images.length > 0 && images.every((image) => image.width === 900 && image.height === 1200),
    distinct_images: images.length > 0 && new Set(images.map((image) => image.sha256)).size === images.length,
    modeling_rendered: modeling.some((item) => item.status === "rendered")
  }
};

await mkdir(outDir, {recursive: true});
await writeFile(join(outDir, `chain-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

const lines = [
  `# 链路实测证据 ${runId}`,
  "",
  `- 状态：${evidence.status} · 用时 ${((evidence.duration_ms ?? 0) / 1000).toFixed(1)}s · 品类 ${evidence.inputs?.category} / 法域 ${evidence.inputs?.region}`,
  `- 判别：${evidence.judgments.total} 次（${Object.entries(evidence.judgments.by_source).map(([key, value]) => `${key}=${value}`).join(" / ")}），合计 ${tokens.total_tokens} token`,
  `- 降级：${evidence.degradations.length === 0 ? "无" : evidence.degradations.map((item) => `${item.kind}: ${item.detail}`).join("；")}`,
  `- 证据等级：判别 ${evidence.evidence_levels.llm_judgments} ｜ 出图 ${evidence.evidence_levels.images}`,
  `- 人群：${evidence.personas.map((item) => `${item.sku}=${item.id ?? "unassigned"}(${item.decision ?? "-"}${item.gate_capped ? "，封顶" : ""})`).join("，")}；探索配额 ${evidence.persona_gate?.quota_used ?? 0}/${evidence.persona_gate?.quota_total ?? 0}`,
  "",
  "| 判别点 | 来源 | 采用 | 置信 | 耗时 | token | 解析层 |",
  "|---|---|---|---|---|---|---|"
];
for (const item of judgments) {
  lines.push(`| ${item.point} | ${item.source} | ${item.accepted ? "是" : "否"} | ${item.confidence ?? "-"} | ${item.latency_ms ? `${(item.latency_ms / 1000).toFixed(1)}s` : "-"} | ${item.total_tokens ?? "-"} | ${item.parse_layer ?? "-"} |`);
}
lines.push("");
lines.push(`出图 ${images.length} 张${evidence.verdicts.sizes_ok ? "，全部 900×1200" : ""}${evidence.verdicts.distinct_images ? "，两两可区分" : ""}；建模 ${modeling.map((item) => `${item.sku}=${item.status}${item.files > 0 ? `（${item.files} 个文件）` : ""}`).join("，")}`);
lines.push(
  "",
  "展陈渲染边界（口径固定，不随运行变化）：几何复用建模技能的 zoomcare-pillbox 展位预设，招牌与材质观感由该技能 scene.html 固定；商品本体不在场景内；" +
  "design.json 里的材质色是否被渲染场景消费未做像素级验证（两次真渲对比几乎逐像素相同）。"
);
await writeFile(join(outDir, `chain-${runId}.md`), `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify({ok: true, out: outDir, verdicts: evidence.verdicts}, null, 2));
