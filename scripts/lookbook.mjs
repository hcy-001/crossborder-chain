#!/usr/bin/env node
/**
 * 把一次真实运行排成一份可翻看的成品质检页（HTML）。
 * 数据只从既有产物读：回执、判别台账、出包清单；图片从成品包里拷一份，
 * 让这一页单独发出去也能自证（不依赖仓库目录结构）。
 *
 * 用法：node scripts/lookbook.mjs --run <run_id>
 */
import {readdir, readFile, writeFile, mkdir, copyFile} from "node:fs/promises";
import {dirname, join, resolve, basename} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const runId = flag("run");
if (!runId) {
  console.error("用法：node scripts/lookbook.mjs --run <run_id>");
  process.exit(2);
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const runDir = join(ROOT, "runs", runId);
const receipt = await readJson(join(runDir, "chain.receipt.json"));

const journalDir = join(runDir, "judgments");
const files = (await readdir(journalDir).catch(() => [])).filter((name) => name.endsWith(".json"));
const judgments = [];
for (const name of files.sort()) {
  const entry = await readJson(join(journalDir, name));
  judgments.push(entry);
}

const outDir = join(ROOT, "out", "verification", `lookbook-${runId}`);
const imgDir = join(outDir, "images");
await mkdir(imgDir, {recursive: true});

const ROLE_LABEL = {
  white_background: "主图位（白底）",
  scene: "场景图",
  detail: "面料特写",
  size: "平铺量尺"
};

const blocks = [];
for (const item of receipt.stages?.produce ?? []) {
  if (!item.package_dir) continue;
  const manifest = await readJson(join(item.package_dir, "master/manifest.json")).catch(() => null);
  const cards = [];
  for (const image of manifest?.images ?? []) {
    const source = join(item.package_dir, "master", image.file);
    const target = join(imgDir, basename(image.file));
    await copyFile(source, target).catch(() => null);
    cards.push(`      <figure class="card">
        <img src="images/${basename(image.file)}" alt="${image.role}" loading="lazy">
        <figcaption><b>${ROLE_LABEL[image.role] ?? image.role}</b><span>${image.width}×${image.height}</span></figcaption>
      </figure>`);
  }
  blocks.push(`  <section class="sku">
    <h2>${item.sku} <small>出包 ${item.package} · 图片 ${item.images} 张 · 展陈渲染 ${item.modeling}</small></h2>
    <div class="grid">
${cards.join("\n")}
    </div>
  </section>`);
}

const judgeRows = judgments.map((entry) => {
  const value = entry.parsed ?? {};
  const brief = value.rationale ?? value.why ?? value.reason ?? (Array.isArray(value.bullets) ? value.bullets[0] : "") ?? "";
  return `<tr>
      <td>${entry.point}</td>
      <td>${entry.source}</td>
      <td>${entry.accepted ? "采用" : "回退"}</td>
      <td>${entry.confidence ?? value.confidence ?? "-"}</td>
      <td>${entry.latency_ms ? (entry.latency_ms / 1000).toFixed(1) + "s" : "-"}</td>
      <td>${entry.usage?.total_tokens ?? "-"}</td>
      <td class="why">${String(brief).slice(0, 160)}</td>
    </tr>`;
}).join("\n");

const bySource = receipt.judges?.by_source ?? {};
const tokens = receipt.judges?.usage?.total_tokens ?? 0;
const degradations = (receipt.degradations ?? []).map((item) => `${item.kind}：${item.detail}`).join("；") || "无";

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>成品自证 ${runId}</title>
<style>
  :root { --ink:#16181d; --dim:#5d6470; --line:#e2e0da; --bg:#faf8f4; --card:#fff; --accent:#8a6f5b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 28px 72px; background:var(--bg); color:var(--ink);
         font:15px/1.65 -apple-system,"Segoe UI","Noto Sans SC",system-ui,sans-serif; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:.01em; }
  .sub { color:var(--dim); margin:0 0 28px; font-size:13px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:34px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  .kpi span { color:var(--dim); font-size:12px; }
  h2 { font-size:17px; margin:38px 0 14px; padding-bottom:8px; border-bottom:1px solid var(--line); }
  h2 small { font-weight:400; color:var(--dim); font-size:12px; margin-left:10px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:16px; }
  .card { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .card img { width:100%; display:block; aspect-ratio:3/4; object-fit:cover; }
  .card figcaption { display:flex; justify-content:space-between; padding:8px 10px; font-size:12px; color:var(--dim); }
  .card figcaption b { color:var(--ink); font-weight:600; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; font-size:13px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:#f2efe9; font-weight:600; font-size:12px; letter-spacing:.03em; }
  td.why { color:var(--dim); }
  .note { margin-top:10px; font-size:12.5px; color:var(--dim); }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; background:#eee9df; color:var(--accent); font-size:12px; }
</style>
</head>
<body>
  <h1>成品与实测：${runId}</h1>
  <p class="sub">品类 ${receipt.inputs?.category} · 目标法域 ${receipt.inputs?.region} · 用时 ${Math.round((receipt.duration_ms ?? 0) / 1000)}s · 生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")}</p>

  <div class="kpis">
    <div class="kpi"><b>${receipt.judges?.total ?? 0}</b><span>判别点（模型 ${bySource.llm ?? 0} / 回退 ${bySource.fallback ?? 0}）</span></div>
    <div class="kpi"><b>${tokens}</b><span>判别 token</span></div>
    <div class="kpi"><b>${receipt.stages?.produce?.[0]?.images ?? 0}</b><span>真实出图（900×1200）</span></div>
    <div class="kpi"><b>${receipt.stages?.produce?.[0]?.modeling ?? "-"}</b><span>展陈渲染</span></div>
    <div class="kpi"><b>${(receipt.degradations ?? []).length}</b><span>降级项</span></div>
  </div>

${blocks.join("\n")}

  <h2>模型判了什么，凭什么 <small>台账逐条可回放</small></h2>
  <table>
    <thead><tr><th>判别点</th><th>来源</th><th>结局</th><th>置信</th><th>耗时</th><th>token</th><th>理由（截取）</th></tr></thead>
    <tbody>
${judgeRows}
    </tbody>
  </table>
  <p class="note">证据等级：判别 ${receipt.evidence_levels?.llm_judgments ?? "-"}；出图 ${receipt.evidence_levels?.images ?? "-"}；展陈渲染 ${receipt.evidence_levels?.modeling ?? "-"}</p>
  <p class="note">降级：${degradations}<br>展陈渲染：${receipt.stages?.produce?.[0]?.modeling_note ?? "-"}</p>
  <p class="note"><span class="badge">边界</span> 未提交平台、未回读；平台标题模板未验时不出 title.txt（见 handoff.md）。<br>
  展陈渲染为基准展位（zoomcare-pillbox）的几何复用，招牌与材质观感由建模技能的 scene.html 固定；商品本体不在场景内，design.json 的色值是否被渲染消费未验证。</p>
</body>
</html>
`;

await writeFile(join(outDir, `lookbook-${runId}.html`), html, "utf8");
console.log(JSON.stringify({ok: true, html: join(outDir, `lookbook-${runId}.html`), images: blocks.length}, null, 2));
