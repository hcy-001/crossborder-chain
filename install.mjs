#!/usr/bin/env node
/**
 * 一键安装：检查 Node → 装依赖 → 冒烟验证。
 *
 * 为什么需要它：这个 skill 只有 ④ 出包用到第三方包，但 ESM 静态 import 会让
 * 缺包表现成「整个项目坏了」。而「先跑 npm ci」这件事，写在 README 里没人看，
 * 所以要有一个能被执行的东西，跑完直接给结论。
 *
 * 用法：
 *   node install.mjs             装依赖并验证
 *   node install.mjs --check     只验证，不安装（已装环境复查用）
 *   node install.mjs --mirror    强制用国内镜像装
 *
 * 退出码：0 通过 | 2 Node 版本过低 | 3 装依赖失败 | 4 冒烟没过
 */

import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const forceMirror = args.includes("--mirror");
const MIRROR = "https://registry.npmmirror.com";

function log(line = "") {
  console.log(line);
}

function fail(code, message, hint = null) {
  console.error("");
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(code);
}

function runNpm(npmArgs) {
  return spawnSync("npm", npmArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true, // Windows 上 npm 是 .cmd，必须过 shell
    env: {...process.env, npm_config_audit: "false", npm_config_fund: "false"}
  });
}

// ── 1. Node 版本 ────────────────────────────────────
const major = Number(process.versions.node.split(".")[0]);
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const required = Number(String(pkg.engines?.node ?? ">=22").replace(/[^0-9]/g, "")) || 22;
log(`Node ${process.versions.node}（要求 ≥ ${required}）`);
if (major < required) {
  fail(2, `Node 版本过低：当前 ${process.versions.node}，需要 ${required} 及以上`,
    "到 nodejs.org 装 LTS 版，或 nvm install 22 / nvm use 22");
}

// ── 2. 依赖 ────────────────────────────────────────
function missingPackages() {
  const need = Object.keys(pkg.dependencies ?? {});
  return need.filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
}

if (!checkOnly) {
  const before = missingPackages();
  if (before.length === 0) {
    log(`依赖已齐全（${Object.keys(pkg.dependencies ?? {}).join(", ")}），跳过安装`);
  } else {
    log("");
    log(`缺 ${before.join(", ")}，开始安装…`);
    let result = runNpm(["ci", "--no-audit", "--no-fund", ...(forceMirror ? [`--registry=${MIRROR}`] : [])]);
    if (result.status !== 0) {
      log("");
      log(`默认源失败，换镜像重试：${MIRROR}`);
      result = runNpm(["ci", "--no-audit", "--no-fund", `--registry=${MIRROR}`]);
    }
    if (result.status !== 0) {
      fail(3, "依赖安装失败",
        "常见原因：网络到 registry.npmjs.org 不通、或 sharp 找不到对应平台的预编译包。"
        + "可试：npm ci --registry=https://registry.npmmirror.com ；仍失败就把 Node 升到 22 LTS。");
    }
  }
}

const stillMissing = missingPackages();
if (stillMissing.length > 0) {
  fail(3, `仍有依赖没装上：${stillMissing.join(", ")}`,
    `在 ${ROOT} 手动跑：npm ci --registry=${MIRROR}`);
}

// ── 3. 冒烟：不联网、不用浏览器 ──────────────────────
log("");
log("冒烟验证（不联网、不用浏览器）：");

const checks = [
  {
    label: "问卷 29 项可打印",
    // 只跑纯 Node 的一段，确认核心模块没有装坏
    run: () => spawnSync(process.execPath, [join(ROOT, "scripts", "intake.mjs"), "--list"], {cwd: ROOT, encoding: "utf8"}),
    verify: (out) => {
      const count = (out.match(/^\d+\. \[/gm) ?? []).length;
      return count === 29 ? `29 项` : `只解析出 ${count} 项`;
    }
  },
  {
    label: "市场扫描帮助可打印",
    run: () => spawnSync(process.execPath, [join(ROOT, "scripts", "market-scan.mjs"), "--help"], {cwd: ROOT, encoding: "utf8"}),
    verify: (out) => (out.includes("用法") ? "ok" : "没有输出用法")
  },
  {
    label: "出包入口依赖检查通过",
    run: () => spawnSync(process.execPath, [join(ROOT, "scripts", "chain.mjs"), "--help"], {cwd: ROOT, encoding: "utf8"}),
    verify: (out, status) => (status === 2 && out.includes("依赖还没装") ? "仍缺依赖" : "ok")
  }
];

let bad = 0;
for (const check of checks) {
  const result = check.run();
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let verdict;
  try {
    verdict = check.verify(combined, result.status);
  } catch (error) {
    verdict = `检查异常：${error.message}`;
  }
  const ok = !/只解析出|仍缺依赖|没有输出|检查异常/.test(verdict);
  if (!ok) bad += 1;
  log(`  ${ok ? "✓" : "✗"} ${check.label} —— ${verdict}`);
}

if (bad > 0) {
  fail(4, `冒烟没过（${bad} 项）`, `在 ${ROOT} 跑 node scripts/intake.mjs --list 看具体输出`);
}

// ── 4. 结论 ────────────────────────────────────────
log("");
log("────────────────────────────────────────");
log("装好了。这个 skill 现在能做什么：");
log("");
log("  不需要任何平台账号、不需要网络：");
log("    node scripts/intake.mjs --list --how        问卷 29 项 + 每项从哪拿");
log("    node scripts/market-scan.mjs --direction \"女士针织开衫\" --region RU   方向验证");
log("    node scripts/select-candidates.mjs --direction \"女士针织开衫\" --region RU   选品候选");
log("    node scripts/source-lookup.mjs --direction \"女士针织开衫\" --region RU   采购规格书");
log("");
log("  一条命令跑完 ①→④（需要网络；--intake 用仓库里的演示答卷）：");
log("    node scripts/run-direction.mjs --direction \"女士针织开衫\" --region RU --intake data/intake/demo-ru.json");
log("");
log("  装进 WorkBuddy（让它在会话里被自动调用）：");
log(`    把整个目录放到 ${"~/.workbuddy/skills/crossborder-chain"}（目录名必须与 SKILL.md 的 name 一致）`);
log("");
