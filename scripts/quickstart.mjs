#!/usr/bin/env node
/**
 * 一条命令跑通全链路（零 key、零网络、零外部技能）。
 *
 * 为什么要有它：评审/朋友下载这个仓库后，第一件事不是读代码，
 * 而是「能不能跑起来、跑出来长什么样」。这个脚本就是那个入口：
 * 用内置样例工单、占位图、桩判别，产出一个真实结构的成品包。
 *
 * 不需要：任何 API key、任何外部 skill、任何网络。
 * 产出：package/<sku>/（9 图 + 尺码映射 + 平台投影 + handoff.md）+ runs/<run_id>/
 *
 * 用法：
 *   npm run quickstart
 */
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `quickstart-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;

console.log("开始演示跑：内置样例工单 · 占位图 · 桩判别（不联网、不花钱）\n");

const result = spawnSync(process.execPath, [
  join(ROOT, "scripts", "chain.mjs"),
  "--category", "女装",
  "--region", "RU",
  "--candidates", "1",
  "--tickets", join(ROOT, "tests", "fixtures", "chain-tickets"),
  "--mock-llm",
  "--mock-images",
  "--run-id", runId
], {
  cwd: ROOT,
  encoding: "utf8",
  env: {...process.env, http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", all_proxy: ""}
});

if (result.stdout) console.log(result.stdout.trimEnd());
if (result.stderr) console.error(result.stderr.trimEnd());

// 交付路径以回执为准：重复跑时目录会带时间片后缀，写死路径会指错地方。
const receiptPath = join(ROOT, "runs", runId, "chain.receipt.json");
let packageDir = null;
try {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  packageDir = receipt.stages?.produce?.[0]?.package_dir ?? null;
} catch { /* 回执读不到就退回默认路径 */ }
const handoff = packageDir ? join(packageDir, "handoff.md") : join(ROOT, "package", "selfgrade-probe-9db535", "handoff.md");
console.log("\n────────────────────────────────────────");
if (result.status === 0) {
  console.log("跑完了。先看这两个文件：");
  if (existsSync(handoff)) console.log(`  交付说明（给人看的）：${handoff.replace(ROOT, "").replace(/^[\\/]/, "").split("\\").join("/")}`);
  console.log(`  运行回执（给机器看的）：runs/${runId}/chain.receipt.json`);
  console.log("\n想跑真实数据：先 `npm run intake -- --list` 答题，再带 --intake 跑。");
} else {
  console.log(`演示跑失败（exit ${result.status}）。上面是完整输出，先看第一条报错。`);
}
process.exit(result.status ?? 1);
