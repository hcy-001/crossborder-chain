#!/usr/bin/env node
/**
 * 上架前必问清单的入口。
 *
 * 用法：
 *   node scripts/intake.mjs --list                       # 打印问卷（拿去问人/问自己）
 *   node scripts/intake.mjs --check --answers a.json     # 只校验，缺必答项 exit 2
 *   node scripts/intake.mjs --answers a.json --sku X     # 校验并写 input/X.intake.json
 *
 * 纪律：缺 blocking 项不许返回 0 —— 这条链路的失败模式从来不是"跑不起来"，
 * 是"跑完了但尺码/运费/佣金是拍脑袋填的"。
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {INTAKE_ITEMS, renderQuestionnaire, validateIntake} from "../core/intake/checklist.mjs";
import {loadAcquisition, renderGuideMd, validateAcquisition} from "../core/intake/acquisition.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : null;
};
const has = (name) => args.includes(`--${name}`);

if (has("help") || args.length === 0) {
  console.log(`上架前必问清单

  node scripts/intake.mjs --list                 # 打印问卷
  node scripts/intake.mjs --list --how           # 打印问卷 + 每项「从哪拿」
  node scripts/intake.mjs --guide                # 只打印「从哪拿」手册（markdown）
  node scripts/intake.mjs --check --answers <answers.json>
  node scripts/intake.mjs --answers <answers.json> --sku <sku>

必答项 ${INTAKE_ITEMS.filter((item) => item.severity === "blocking").length} 条 / 需确认 ${INTAKE_ITEMS.filter((item) => item.severity === "confirm").length} 条 / 可默认 ${INTAKE_ITEMS.filter((item) => item.severity === "defaultable").length} 条`);
  process.exit(0);
}

if (has("guide")) {
  // 生成给人看的「从哪拿」文档。与 --list 分开：一个是问卷，一个是获取手册。
  const {byKey} = await loadAcquisition();
  const check = validateAcquisition(INTAKE_ITEMS, byKey);
  if (!check.ok) {
    console.error(`获取方式与问卷不同步：缺 ${check.missing.join(",") || "-"}；多 ${check.extra.join(",") || "-"}；等级异常 ${check.badLevels.join(",") || "-"}；空字段 ${check.emptyFields.join(",") || "-"}`);
    process.exit(2);
  }
  console.log(renderGuideMd(INTAKE_ITEMS, byKey));
  process.exit(0);
}

if (has("list")) {
  // --how：把「从哪拿」附在每项后面。不传就是原样，输出体积不变。
  let howByKey = null;
  if (has("how")) {
    howByKey = (await loadAcquisition()).byKey;
  }
  console.log(`# 上架前必问清单（共 ${INTAKE_ITEMS.length} 项）${renderQuestionnaire({howByKey})}`);
  process.exit(0);
}

const answersPath = flag("answers");
if (!answersPath || answersPath === true) {
  console.error("需要 --answers <file.json>");
  process.exit(2);
}

let answers;
try {
  answers = JSON.parse(await readFile(resolve(String(answersPath)), "utf8"));
} catch (error) {
  console.error(`读不到答复文件：${error.message}`);
  process.exit(2);
}

const result = validateIntake(answers);

if (has("check")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

const sku = flag("sku");
if (!sku || sku === true) {
  console.error("写文件需要 --sku <sku>");
  process.exit(2);
}

const outFile = join(ROOT, "input", `${sku}.intake.json`);
await mkdir(join(ROOT, "input"), {recursive: true});
await writeFile(outFile, `${JSON.stringify({
  sku,
  checked_at: new Date().toISOString(),
  answers,
  validation: result,
  note: result.ok
    ? "必答项齐全；confirm 项若有默认值已在 defaults_used 里标注"
    : "必答项不全：不得据此出价或上架，先把 blocking_missing 逐条问清"
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: result.ok,
  written: outFile,
  summary: result.summary,
  blocking_missing: result.blocking_missing.map((item) => item.key),
  invalid: result.invalid.map((item) => item.key)
}, null, 2));

process.exit(result.ok ? 0 : 2);
