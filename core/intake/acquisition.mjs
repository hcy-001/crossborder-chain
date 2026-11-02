/**
 * 问卷项的「从哪拿到」。
 *
 * 为什么单独一个模块而不是塞进 checklist：checklist 是「问什么」，
 * 这里是「去哪问、抄什么、查不到怎么办」——后者会随平台后台改版、
 * 货代换人而变，改它的频率远高于问卷本身。分开之后，
 * 问卷稳定、获取方式可迭代，且两边靠 key 对齐，缺一条测试就报。
 *
 * 数据在 data/intake/acquisition.json，本模块只读不写。
 */

import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACQ_PATH = join(ROOT, "data", "intake", "acquisition.json");

/** 责任人分组顺序：从「你自己拍板」到「要别人配合」，按可自行解决程度排。 */
export const OWNER_ORDER = ["自己定", "工具可算", "自己实测", "卖家后台", "供应商", "货代财务", "资质服务商"];

/** 证据等级的含义。写一次，两处（CLI 与文档）共用。 */
export const LEVEL_LEGEND = {
  L2: "本项目实测过这条路径（真的走通了，或真的被挡住）",
  L1: "本地跑通，但没真的从后台/报价单抄到值",
  L0: "按信息性质推断，未亲自走一遍"
};

export async function loadAcquisition(path = ACQ_PATH) {
  const doc = JSON.parse(await readFile(path, "utf8"));
  const byKey = new Map();
  for (const item of doc.items ?? []) byKey.set(item.key, item);
  return {doc, byKey};
}

/**
 * 把问卷项与获取方式合并。
 *
 * 找不到对应项时**不静默跳过**：返回 missing 让上层报错。
 * 静默跳过会变成「文档里少了几项」，而少的那几项恰恰最可能是新加的、最不清楚怎么拿的。
 */
export function mergeGuide(items, byKey) {
  const merged = [];
  const missing = [];
  for (const item of items) {
    const how = byKey.get(item.key);
    if (!how) {
      missing.push(item.key);
      continue;
    }
    merged.push({...item, how});
  }
  return {merged, missing};
}

/** 校验两边是否对齐。给测试用，也给 `intake.mjs --guide` 启动时自检用。 */
export function validateAcquisition(items, byKey) {
  const itemKeys = new Set(items.map((item) => item.key));
  const missing = [...itemKeys].filter((key) => !byKey.has(key));
  const extra = [...byKey.keys()].filter((key) => !itemKeys.has(key));
  const badLevels = [];
  const emptyFields = [];
  for (const [key, how] of byKey) {
    if (!Object.hasOwn(LEVEL_LEGEND, how.level)) badLevels.push(`${key}=${how.level}`);
    for (const field of ["owner", "at", "take", "fallback"]) {
      if (!how[field] || String(how[field]).trim() === "") emptyFields.push(`${key}.${field}`);
    }
    if (how.owner && !OWNER_ORDER.includes(how.owner)) badLevels.push(`${key}.owner=${how.owner}`);
  }
  return {ok: missing.length === 0 && extra.length === 0 && badLevels.length === 0 && emptyFields.length === 0, missing, extra, badLevels, emptyFields};
}

function groupByOwner(merged) {
  const groups = new Map(OWNER_ORDER.map((owner) => [owner, []]));
  for (const item of merged) {
    const owner = item.how.owner;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(item);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0);
}

const SEVERITY_LABEL = {
  blocking: "阻断出包",
  confirm: "需确认",
  defaultable: "可默认"
};

/**
 * 渲染成人读的 Markdown。
 *
 * 结构：先一张「谁去办」总表（一眼看清哪些不用求人），再按责任人分组的明细。
 * 不放推理过程，只留「问什么 / 从哪拿 / 抄什么 / 查不到怎么办」。
 */
export function renderGuideMd(items, byKey) {
  const {merged} = mergeGuide(items, byKey);
  const groups = groupByOwner(merged);
  const lines = [];

  lines.push("# 信息需求清单：29 项，逐项写清「从哪拿」");
  lines.push("");
  lines.push("> 本文件由 `npm run intake:guide` 生成，源是 `core/intake/checklist.mjs`（问什么）与 `data/intake/acquisition.json`（从哪拿）。改任一处后重跑，**不要手改本文件**。");
  lines.push("> 写 `unknown` 是明确表态，不是漏答：系统会如实降级（不出价 / 不出图 / 标未核），不会替你编数字。");
  lines.push("");

  // ── 总表：谁去办 ──
  lines.push("## 谁去办");
  lines.push("");
  lines.push("| 责任 | 项数 | 涉及项 |");
  lines.push("|---|---|---|");
  for (const [owner, list] of groups) {
    lines.push(`| ${owner} | ${list.length} | ${list.map((item) => item.key).join("、")} |`);
  }
  lines.push("");

  const byTool = groups.find(([owner]) => owner === "工具可算");
  if (byTool) {
    lines.push(`**${byTool[1].length} 项不用你查**：${byTool[1].map((item) => item.key).join("、")} —— 脚本已经能算出来（见 \`npm run chain:dir\` 自动填的部分）。`);
    lines.push("");
  }

  // ── 明细 ──
  lines.push("## 逐项：从哪拿");
  lines.push("");
  for (const [owner, list] of groups) {
    lines.push(`### ${owner}（${list.length} 项）`);
    lines.push("");
    for (const item of list) {
      const how = item.how;
      lines.push(`#### \`${item.key}\` — ${item.question}`);
      lines.push("");
      lines.push(`- **性质**：${SEVERITY_LABEL[item.severity] ?? item.severity}${item.unknown_ok ? "（可写 unknown）" : "（不可留空）"}`);
      lines.push(`- **从哪拿**：${how.at}`);
      lines.push(`- **抄什么**：${how.take}`);
      lines.push(`- **查不到怎么办**：${how.fallback}`);
      lines.push(`- **这条路径的证据等级**：\`${how.level}\` — ${LEVEL_LEGEND[how.level]}`);
      lines.push(`- **为什么问**：${item.why}`);
      lines.push("");
    }
  }

  // ── 附 ──
  lines.push("## 等级说明");
  lines.push("");
  lines.push("| 等级 | 含义 |");
  lines.push("|---|---|");
  for (const [level, meaning] of Object.entries(LEVEL_LEGEND)) {
    lines.push(`| \`${level}\` | ${meaning} |`);
  }
  lines.push("");
  lines.push("等级说的是**这条获取路径**被验证到什么程度，不是这条信息本身多重要。`L0` 不代表值不可信，只代表「我还没亲自走一遍这条路」。");
  lines.push("");

  return `${lines.join("\n")}`;
}

/** 给 `intake.mjs --how` 用的紧凑追加块：只补三行，不重排原有输出。 */
export function renderHowBlock(how) {
  return [
    `   从哪拿：${how.at}`,
    `   抄什么：${how.take}`,
    `   查不到：${how.fallback}　（${how.owner} ｜ ${how.level}）`
  ].join("\n");
}
