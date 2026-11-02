import sharp from "sharp";

/**
 * 尺码示意卡：把工单里的尺码表画成一张可上详情页的图。
 *
 * 为什么是这张图、而不是三维展位：
 * - 它 100% 由数据驱动 —— 图上每个数字都能追到 `size.rows`，可核对、可复算；
 * - 它真的进得了商品详情页（平台要求「尺码表/尺寸图」是常态需求）；
 * - 展位渲染出来的是场景，不是商品，替代不了任何一位置上架材料。
 *
 * 纪律：没有 rows 就不出图（返回 skipped，写明原因），绝不拿空表头凑一张。
 */

const WIDTH = 900;
const HEIGHT = 1200;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 表格数据的规范化：rows 既可能是对象（size → 各列），也可能是数组。 */
export function normalizeSizeRows(size) {
  const columns = Array.isArray(size?.columns) ? size.columns.map(String) : [];
  const raw = size?.rows ?? null;
  if (!raw || columns.length === 0) return {columns, rows: []};

  const rows = Array.isArray(raw)
    ? raw.map((cells) => ({key: String(cells?.[0] ?? ""), cells: cells.map(String)}))
    : Object.entries(raw).map(([key, cells]) => ({
      key: String(key),
      cells: Array.isArray(cells) ? [String(key), ...cells.map(String)] : [String(key), String(cells)]
    }));

  return {columns, rows: rows.filter((row) => row.cells.length >= 2)};
}

/**
 * 卡片 SVG：纯几何与文字，不画写实内容（写实交给图像模型）。
 *
 * 排版规则来自实物毛病，不是为了好看：
 * - 表头会用俄文长词（"Международный размер"），20px 一行必然叠字 → 按列宽自动换行、字号降到 15；
 * - 只有 1 行尺码时表格会顶在画面上方留一大片空白 → 表格块整体垂直居中；
 * - 列之间要有竖线，否则数字落哪一列靠猜。
 */
export function buildSizeCardSvg({size, title = null, note = null}) {
  const {columns, rows} = normalizeSizeRows(size);
  if (rows.length === 0) return null;

  const colCount = Math.max(...rows.map((row) => row.cells.length), columns.length);
  const left = 48;
  const tableWidth = WIDTH - left * 2;
  const colWidth = tableWidth / colCount;
  const rowHeight = 64;
  const headerHeight = 92;
  // 行数上限按版面倒算：表头 92 + 行高 64，底部要留标题与出处，最多 10 行不溢出。
  const bodyRows = rows.slice(0, 10);
  const tableHeight = headerHeight + rowHeight * bodyRows.length;
  // 行少时表格就贴着副标题（大留白会让卡片看起来像没做完）；行多时上移到 240 起步。
  const tableTop = tableHeight <= 520 ? 300 : 240;

  const fontFamily = "system-ui,-apple-system,Segoe UI,Noto Sans,sans-serif";

  /** 按列宽估算可容纳字符数，超了就断成两行（俄文按空格断，中文按字断）。 */
  const wrapHeader = (label) => {
    const text = String(label ?? "");
    const perLine = Math.max(6, Math.floor((colWidth - 16) / 8));
    if (text.length <= perLine) return [text];
    const words = text.split(" ");
    if (words.length === 1) {
      const mid = Math.ceil(text.length / 2);
      return [text.slice(0, mid), text.slice(mid)];
    }
    const lines = [""];
    for (const word of words) {
      const current = lines[lines.length - 1];
      if ((current ? `${current} ${word}` : word).length <= perLine) {
        lines[lines.length - 1] = current ? `${current} ${word}` : word;
      } else if (lines.length < 2) {
        lines.push(word);
      } else {
        lines[1] = `${lines[1]} ${word}`;
      }
    }
    return lines.slice(0, 2);
  };

  const headerCells = Array.from({length: colCount}, (_, index) => {
    const lines = wrapHeader(columns[index] ?? (index === 0 ? "Размер" : ""));
    const cx = left + colWidth * index + colWidth / 2;
    const startY = tableTop + headerHeight / 2 - (lines.length - 1) * 11;
    const tspans = lines.map((line, lineIndex) =>
      `<text x="${cx}" y="${startY + lineIndex * 22}" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-size="15" font-weight="600" fill="#2C2C2A">${escapeXml(line)}</text>`
    ).join("");
    return tspans;
  }).join("");

  const body = bodyRows.map((row, rowIndex) => {
    const y = tableTop + headerHeight + rowHeight * rowIndex;
    const cells = Array.from({length: colCount}, (_, index) => {
      const value = row.cells[index] ?? "";
      return `<text x="${left + colWidth * index + colWidth / 2}" y="${y + rowHeight / 2}" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-size="22" font-weight="${index === 0 ? 600 : 400}" fill="#2C2C2A">${escapeXml(value)}</text>`;
    }).join("");
    const fill = rowIndex % 2 === 0 ? "#F7F5F0" : "#FFFFFF";
    return `<rect x="${left}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${fill}" stroke="none"/>${cells}`;
  }).join("");

  const horizontal = Array.from({length: bodyRows.length + 1}, (_, index) => {
    const y = tableTop + headerHeight + rowHeight * index;
    return `<line x1="${left}" y1="${y}" x2="${left + tableWidth}" y2="${y}" stroke="#D8D4CB" stroke-width="1"/>`;
  }).join("");
  const vertical = Array.from({length: colCount - 1}, (_, index) => {
    const x = left + colWidth * (index + 1);
    return `<line x1="${x}" y1="${tableTop}" x2="${x}" y2="${tableTop + tableHeight}" stroke="#E4E0D6" stroke-width="1"/>`;
  }).join("");

  const titleText = title ? escapeXml(title) : "Размерная сетка";
  const noteText = note ?? "Источник: карточка поставщика. Не измерено вживую.";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF"/>
<text x="${WIDTH / 2}" y="120" text-anchor="middle" font-family="${fontFamily}" font-size="40" font-weight="600" fill="#16181D">${titleText}</text>
<text x="${WIDTH / 2}" y="168" text-anchor="middle" font-family="${fontFamily}" font-size="20" fill="#5D6470">${escapeXml(size?.label ?? "см")}</text>
<rect x="${left}" y="${tableTop}" width="${tableWidth}" height="${headerHeight}" fill="#EFEBE2" stroke="none"/>
${headerCells}
${body}
${horizontal}
${vertical}
<rect x="${left}" y="${tableTop}" width="${tableWidth}" height="${tableHeight}" fill="none" stroke="#B9B3A7" stroke-width="1.5"/>
<text x="${WIDTH / 2}" y="${HEIGHT - 72}" text-anchor="middle" font-family="${fontFamily}" font-size="18" fill="#7A8089">${escapeXml(noteText)}</text>
</svg>`;
}

export async function renderSizeCard({size, outFile, title = null, note = null}) {
  const svg = buildSizeCardSvg({size, title, note});
  if (!svg) {
    return {ok: false, reason: "no_size_rows", detail: "尺码表只有表头或为空，不出示意图（不拿空表凑图）"};
  }
  await sharp(Buffer.from(svg)).png({compressionLevel: 9}).toFile(outFile);
  return {ok: true, file: outFile, width: WIDTH, height: HEIGHT, rows: normalizeSizeRows(size).rows.length};
}
