/**
 * 把卖家在问卷里手写的尺码表解析成 rows。
 *
 * 为什么需要：问卷里问的是「尺码表的具体数值」，人写出来是这种：
 *   48: M/L, 96-104, 72
 *   50: L/XL, 100-108, 74
 * 或者一行串起来用分号隔开。工单里有结构化 rows 时以工单为准，
 * 没有时用这份手写值 —— 否则"问了却不生效"，等于没问。
 *
 * 解析失败不猜：返回 {rows: null, reason}，由调用方决定降级方式。
 */

const ROW_SEPARATOR = /\n|;|；/;

export function parseSizeRows(text, columns = []) {
  const raw = String(text ?? "").trim();
  if (raw === "") return {rows: null, reason: "empty"};

  const lines = raw.split(ROW_SEPARATOR).map((line) => line.trim()).filter(Boolean);
  const rows = {};
  for (const line of lines) {
    // 形如 "48: M/L, 96-104, 72" / "48：M/L，96-104" / "48/M/L/96-104"
    const split = line.split(/[:：]/);
    let key;
    let cells;
    if (split.length >= 2) {
      key = split[0].trim();
      cells = split.slice(1).join(":").split(/[,，]/).map((cell) => cell.trim()).filter(Boolean);
    } else {
      const parts = line.split(/[,，]/).map((cell) => cell.trim()).filter(Boolean);
      if (parts.length < 2) break;
      [key, ...cells] = parts;
    }
    if (!key || cells.length === 0) break;
    // 第二列是国际码时一并保留（有就用，没有不影响）
    rows[key] = cells;
  }

  const keys = Object.keys(rows);
  if (keys.length === 0) return {rows: null, reason: "unparsable", detail: `没能从「${raw.slice(0, 40)}」里读出任何「码号: 数值」`};

  return {
    rows,
    reason: null,
    parsed_rows: keys.length,
    columns: columns.length > 0 ? columns : ["尺码", "数值"]
  };
}
