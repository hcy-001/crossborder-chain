/**
 * 找出某个 SKU 最新的那个包目录。
 *
 * 为什么按 mtime 而不是按名字：目录名带时间片（`<sku>__HHMMSS`），但跨天之后就
 * 不再单调，按名字排序会把旧包当成"最新"，于是检查器报告的其实是上一轮的产物。
 */
import {readdir, stat} from "node:fs/promises";
import {join} from "node:path";

export async function pickPackageDir(packageRoot, sku) {
  const names = (await readdir(packageRoot).catch(() => []))
    .filter((name) => name === sku || name.startsWith(`${sku}__`));
  if (names.length === 0) return null;
  const stamped = await Promise.all(names.map(async (name) => {
    const info = await stat(join(packageRoot, name)).catch(() => null);
    return {name, mtime: info?.mtimeMs ?? 0};
  }));
  stamped.sort((left, right) => right.mtime - left.mtime);
  return {name: stamped[0].name, dir: join(packageRoot, stamped[0].name), all: stamped.map((item) => item.name)};
}
