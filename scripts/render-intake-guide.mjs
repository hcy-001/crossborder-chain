#!/usr/bin/env node
/**
 * 把「信息需求清单 + 从哪拿」渲染成 docs/信息需求清单.md。
 *
 * 为什么要脚本而不是手写：这份表会随问卷项与获取路径变，手写必然漂移。
 * 源只有两处：core/intake/checklist.mjs（问什么）、data/intake/acquisition.json（从哪拿）。
 */

import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {loadAcquisition, renderGuideMd, validateAcquisition} from "../core/intake/acquisition.mjs";
import {INTAKE_ITEMS} from "../core/intake/checklist.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "信息需求清单.md");

const {byKey} = await loadAcquisition();
const check = validateAcquisition(INTAKE_ITEMS, byKey);
if (!check.ok) {
  console.error("获取方式与问卷不同步，拒绝渲染：");
  if (check.missing.length) console.error(`  缺：${check.missing.join(", ")}`);
  if (check.extra.length) console.error(`  多：${check.extra.join(", ")}`);
  if (check.badLevels.length) console.error(`  等级/归属异常：${check.badLevels.join(", ")}`);
  if (check.emptyFields.length) console.error(`  空字段：${check.emptyFields.join(", ")}`);
  process.exit(2);
}

const md = renderGuideMd(INTAKE_ITEMS, byKey);
await mkdir(dirname(OUT), {recursive: true});
await writeFile(OUT, `${md}\n`, "utf8");
console.log(`已渲染：${OUT.replaceAll("\\", "/")}`);
console.log(`  问卷 ${INTAKE_ITEMS.length} 项，获取方式 ${byKey.size} 条，正文 ${md.split("\n").length} 行`);
