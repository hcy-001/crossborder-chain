/**
 * 一页商品卡：把这一个包"最终交出去的东西"渲染成一页 HTML。
 *
 * 数据纪律：
 * 1. 所有数字与文字都从包内文件读，不在这里新增判断、不补默认值；
 * 2. 读不到就显式写"未产出 / 缺"，不渲染成 0 或空；
 * 3. 页面只做呈现，配色与字号固定，不引用外部资源 —— 断网也能打开、能打印。
 */
import {readFile} from "node:fs/promises";
import {join} from "node:path";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseCsv(text) {
  if (!text) return [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (char === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }
    cells.push(cell);
    return cells;
  };
  const headers = split(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

const statusLabel = (value) => ({
  validated: "已校验",
  unverified: "未校验",
  placeholder: "占位图"
}[value] ?? String(value ?? "未知"));

function priceBlock(pricing) {
  if (!pricing || pricing.status !== "available" || !pricing.result) {
    const reasons = (pricing?.reasons ?? []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
    return `<div class="note warn">未出价${reasons ? `<ul>${reasons}</ul>` : ""}</div>`;
  }
  const result = pricing.result;
  const currency = escapeHtml(result.currency ?? "");
  const money = (value) => (value === null || value === undefined ? "—" : `${Number(value).toFixed(2)} ${currency}`);
  // 分母法（现行口径）：margin.suggested_price 是建议售价，break_even 是保本价。
  if (result.margin) {
    const margin = result.margin;
    const pct = margin.target_rate === null || margin.target_rate === undefined
      ? "—"
      : `${(Number(margin.target_rate) * 100).toFixed(1)}%`;
    return `<table class="kv">
      <tr><th>建议售价</th><td><strong>${money(margin.suggested_price)}</strong></td></tr>
      <tr><th>保本价</th><td>${money(margin.break_even)}</td></tr>
      <tr><th>目标毛利</th><td>${pct}</td></tr>
      <tr><th>毛利额</th><td>${money(margin.gross_profit)}</td></tr>
      ${result.formula ? `<tr><th>口径</th><td class="dim">${escapeHtml(result.formula)}</td></tr>` : ""}
    </table>`;
  }
  // 旧口径（成本累加）：只认 total，不假装它是售价。
  return `<table class="kv">
    <tr><th>成本合计</th><td>${money(result.total)}</td></tr>
    <tr><th class="dim">口径</th><td class="dim">成本累加，不含毛利；不上架价</td></tr>
  </table>`;
}

/**
 * @returns {Promise<{html: string, stats: object}>}
 */
export async function renderOnepager({packageDir, platform = null} = {}) {
  const manifest = await readJson(join(packageDir, "master", "manifest.json"));
  const receipt = await readJson(join(packageDir, "receipt.json"));
  const compliance = await readJson(join(packageDir, "master", "compliance", "report.json"));
  const platformsDir = await readText(join(packageDir, "platforms")); // 目录不可读时返回 null
  void platformsDir;

  // 平台目录名从投影结果里取；没指定就用第一个存在的。
  let platformIds = [];
  if (platform) {
    platformIds = [platform];
  } else {
    const {readdir} = await import("node:fs/promises");
    platformIds = await readdir(join(packageDir, "platforms")).catch(() => []);
  }

  const images = (manifest?.images ?? []).filter((image) => image?.file);
  const attributes = platformIds.length
    ? parseCsv(await readText(join(packageDir, "platforms", platformIds[0], "attributes.csv")))
    : [];
  const validation = platformIds.length
    ? await readJson(join(packageDir, "platforms", platformIds[0], "validate.json"))
    : null;
  const sizeMapping = platformIds.length
    ? await readJson(join(packageDir, "platforms", platformIds[0], "size-mapping.json"))
    : null;
  const titleAuto = platformIds.length
    ? await readJson(join(packageDir, "platforms", platformIds[0], "title.auto.json"))
    : null;
  const copyDesc = await readText(join(packageDir, "master", "copy", "desc.txt"));
  const copyBullets = await readJson(join(packageDir, "master", "copy", "bullets.json"));

  const platformRoot = platformIds.length ? `platforms/${platformIds[0]}` : "platforms";
  const imageCards = images.map((image) => `
    <figure>
      <img src="${escapeHtml(`master/${image.file}`)}" alt="${escapeHtml(image.role ?? image.file)}" loading="lazy">
      <figcaption>${escapeHtml(image.role ?? "")}<span>${image.width ?? "?"}×${image.height ?? "?"}</span></figcaption>
    </figure>`).join("");

  const attrRows = attributes.map((row) => `
    <tr>
      <td class="mono">${escapeHtml(row.platform_key ?? row.canonical_key)}</td>
      <td>${escapeHtml(row.value)}</td>
      <td class="dim">${escapeHtml(row.canonical_key)}</td>
    </tr>`).join("");

  const sizeValue = sizeMapping?.payload?.attribute_value ?? null;
  const sizeCheck = sizeMapping?.payload?.size_value_check ?? null;
  const complianceItems = compliance?.items ?? [];
  const blockers = (receipt?.gates ?? []).filter((gate) => gate.status !== "pass");

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>${escapeHtml(manifest?.sku ?? "商品卡")} · 一页商品卡</title>
<style>
  :root{--ink:#1b1b1f;--dim:#6b6b76;--line:#e3e3e8;--bg:#fff;--soft:#f7f7f9;--ok:#0a7b48;--warn:#a35a00;--bad:#b3261e}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 28px 56px;background:var(--bg);color:var(--ink);
       font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:15px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .meta{color:var(--dim);font-size:12px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
  .chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;background:var(--soft)}
  .chip.ok{color:var(--ok);border-color:#bfe3d0;background:#f2fbf6}
  .chip.warn{color:var(--warn);border-color:#f0dcbf;background:#fffaf2}
  .chip.bad{color:var(--bad);border-color:#f0c9c5;background:#fdf4f3}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
  figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--soft)}
  figure img{display:block;width:100%;height:auto}
  figcaption{display:flex;justify-content:space-between;gap:6px;padding:4px 8px;font-size:11px;color:var(--dim)}
  table{width:100%;border-collapse:collapse}
  .kv th{text-align:left;font-weight:500;color:var(--dim);width:96px;padding:6px 8px;border-bottom:1px solid var(--line)}
  .kv td{padding:6px 8px;border-bottom:1px solid var(--line)}
  table.rows th{text-align:left;font-size:12px;color:var(--dim);border-bottom:1px solid var(--line);padding:6px 8px}
  table.rows td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .dim{color:var(--dim);font-size:12px}
  .note{padding:10px 12px;border-radius:8px;background:var(--soft);border:1px solid var(--line);font-size:13px}
  .note.warn{background:#fffaf2;border-color:#f0dcbf}
  ul{margin:6px 0 0 18px;padding:0}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media (max-width:720px){
    .two{grid-template-columns:1fr}
    /* 窄屏把行改成块状，避免俄文长字段被挤成逐字换行 */
    table.rows thead{display:none}
    table.rows tr{display:block;padding:8px 0;border-bottom:1px solid var(--line)}
    table.rows td{display:block;border:none;padding:1px 0;word-break:break-word}
    table.rows td.mono{font-weight:600}
  }
  @media print{body{padding:0}.grid{grid-template-columns:repeat(3,1fr)}}
</style></head>
<body>
  <h1>${escapeHtml(manifest?.sku ?? "未命名")}</h1>
  <div class="meta">${escapeHtml(manifest?.category ?? "类目未记")} · ${escapeHtml(manifest?.region ?? "地区未记")} · 平台 ${escapeHtml(platformIds.join(" / ") || "未产出")} · 生成 ${escapeHtml(receipt?.finished_at ?? "")}</div>
  <div class="chips">
    <span class="chip">图片 ${images.length} 张</span>
    <span class="chip ${validation?.quality === "validated" ? "ok" : "warn"}">投影 ${statusLabel(validation?.quality)}</span>
    <span class="chip ${receipt?.pricing?.status === "available" ? "ok" : "warn"}">定价 ${receipt?.pricing?.status === "available" ? "已出价" : "未出价"}</span>
    <span class="chip ${sizeValue ? "ok" : "warn"}">尺码 ${escapeHtml(sizeValue ?? "未产出")}</span>
  </div>

  <h2>母版图</h2>
  ${imageCards ? `<div class="grid">${imageCards}</div>` : `<div class="note warn">本包没有图片</div>`}

  <div class="two">
    <div>
      <h2>定价</h2>
      ${priceBlock(receipt?.pricing)}
    </div>
    <div>
      <h2>尺码</h2>
      <table class="kv">
        <tr><th>字段值</th><td>${escapeHtml(sizeValue ?? "未产出")}</td></tr>
        <tr><th>判定</th><td>${escapeHtml(sizeCheck?.status ?? "未判定")}</td></tr>
        ${(sizeCheck?.actions ?? []).map((text) => `<tr><th>待办</th><td>${escapeHtml(text)}</td></tr>`).join("")}
        ${(sizeCheck?.violations ?? []).map((item) => `<tr><th>违规</th><td class="dim">${escapeHtml(item.code)} — ${escapeHtml(item.detail)}</td></tr>`).join("")}
      </table>
    </div>
  </div>

  <h2>平台属性</h2>
  ${attrRows ? `<table class="rows"><thead><tr><th>平台字段</th><th>值</th><th>内部键</th></tr></thead><tbody>${attrRows}</tbody></table>` : `<div class="note warn">该平台没有产出 attributes.csv</div>`}

  ${titleAuto ? `<h2>标题</h2>
  <div class="note">
    <strong>由平台按必填特征自动生成</strong>（${escapeHtml(titleAuto.platform_format)}）<br>
    ${escapeHtml(titleAuto.what_to_do)}<br>
    <span class="dim">参考名：${escapeHtml(titleAuto.reference_name_preview)}</span>
  </div>` : ""}

  ${copyDesc ? `<h2>文案</h2>
  <div class="note" style="white-space:pre-wrap">${escapeHtml(copyDesc).slice(0, 1200)}</div>
  ${Array.isArray(copyBullets) && copyBullets.length ? `<ul>${copyBullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}` : ""}

  <h2>合规</h2>
  ${complianceItems.length ? `<table class="rows"><thead><tr><th>层</th><th>要求</th><th>状态</th></tr></thead><tbody>
    ${complianceItems.slice(0, 8).map((item) => `<tr><td class="mono">${escapeHtml(item.layer)}</td><td>${escapeHtml(item.requirement)}</td><td>${escapeHtml(item.status)} <span class="dim">${escapeHtml(item.confidence ?? "")}</span></td></tr>`).join("")}
  </tbody></table>` : `<div class="note warn">没有合规报告</div>`}

  <h2>未决与降级</h2>
  ${(receipt?.degradations ?? []).length
    ? `<ul>${receipt.degradations.map((item) => `<li>${escapeHtml(item.kind)}：${escapeHtml(item.detail)}</li>`).join("")}</ul>`
    : `<div class="note">本次运行没有记录降级项。</div>`}
  ${blockers.length ? `<ul>${blockers.map((gate) => `<li>${escapeHtml(gate.id)} ${escapeHtml(gate.status)}</li>`).join("")}</ul>` : ""}

  <div class="meta" style="margin-top:28px">
    数据来源：master/manifest.json、${escapeHtml(platformRoot)}/attributes.csv、${escapeHtml(platformRoot)}/validate.json、size-mapping.json、receipt.json、master/compliance/report.json。
    本页只做呈现，不含新结论。
  </div>
</body></html>
`;

  return {
    html,
    stats: {
      images: images.length,
      attributes: attributes.length,
      platforms: platformIds,
      compliance_items: complianceItems.length,
      degradations: (receipt?.degradations ?? []).length
    }
  };
}

export async function writeOnepager({packageDir, platform = null, file = null} = {}) {
  const target = file ?? join(packageDir, "onepager.html");
  const {html, stats} = await renderOnepager({packageDir, platform});
  const {writeFile} = await import("node:fs/promises");
  await writeFile(target, html, "utf8");
  return {file: target, stats};
}
