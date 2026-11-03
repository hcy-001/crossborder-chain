/**
 * 第三方依赖探测。
 *
 * 为什么需要它：只有 ④ 出包用到 ajv 与 sharp，①②③ 和问卷全是纯 Node。
 * 但 ESM 的 import 是静态提升的 —— 缺包时会在模块加载阶段抛 ERR_MODULE_NOT_FOUND，
 * 报错长这样：`Cannot find package 'sharp' imported from ...`。
 * 对一个刚 clone 下来、还没跑 npm ci 的人，这句话等于「坏了」，而不是「还没装依赖」。
 *
 * 所以入口脚本先探一次，缺了就用人话说清楚：缺哪个、干什么用、一条命令怎么装。
 */

import {createRequire} from "node:module";

const require = createRequire(import.meta.url);

/** 出包段需要的包，以及缺了会影响什么。顺序即提示顺序。 */
export const PACKAGES = [
  {
    name: "ajv",
    why: "校验包内 JSON 与契约（只影响 ④ 出包）",
    install: "npm ci"
  },
  {
    name: "sharp",
    why: "图像裁切与白底补边（只影响 ④ 出包；原生模块，按平台下载预编译二进制）",
    install: "npm ci"
  }
];

/** 返回缺失的包（空数组表示齐全）。不抛错，供调用方决定怎么处理。 */
export function probeDeps(packages = PACKAGES) {
  const missing = [];
  for (const item of packages) {
    try {
      require.resolve(item.name);
    } catch {
      missing.push(item);
    }
  }
  return missing;
}

/**
 * 缺依赖时打印指引并退出。
 *
 * `fallback` 是「不装依赖也能干什么」——这句话比报错本身重要：
 * 用户会以为整个工具坏了，实际只有最后一段用不了。
 */
export function assertDeps({fallback = null, usage = null} = {}) {
  const missing = probeDeps();
  if (missing.length === 0) return true;

  const lines = [
    "",
    "这一段的依赖还没装（不影响前面几段）：",
    ...missing.map((item) => `  · ${item.name} —— ${item.why}`),
    "",
    "装依赖（仓库根目录跑一次，约 4 秒）：",
    "  npm ci",
    "",
    "国内网络或没有编译环境时，换镜像重试：",
    "  npm ci --registry=https://registry.npmmirror.com",
    ""
  ];
  if (fallback) lines.push(fallback, "");
  if (usage) lines.push(`这一段本身的用法：${usage}`, "");

  console.error(lines.join("\n"));
  process.exit(2);
}


/**
 * 缺依赖就自己装，装完继续 —— 让「拖进 skills 目录」这件事真的成立。
 *
 * 为什么必须自动：装 skill 的实际动作是「把文件夹拖进 skills 目录」或 git clone，
 * 没有人会先去终端敲 npm ci。要求手动装依赖，等于要求使用者先读 README 再动手，
 * 那不是 skill 的用法，是项目的用法。
 *
 * 边界：
 * - 只装自己这一个包的依赖（cwd 固定在仓库根），不碰全局
 * - 只在第一次缺依赖时发生，之后 require.resolve 能过就不再联网
 * - 装不上不硬撑：打印手动命令后 exit 2，并说明 ①②③ 不依赖它们
 */
export async function ensureDeps({autoInstall = true, quiet = false} = {}) {
  const missing = probeDeps();
  if (missing.length === 0) return true;

  if (!autoInstall) {
    assertDeps({fallback: "不装也能跑：①②③ 与问卷。"});
    return false;
  }

  const {spawnSync} = await import("node:child_process");
  const {dirname} = await import("node:path");
  const {fileURLToPath} = await import("node:url");
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const MIRROR = "https://registry.npmmirror.com";

  const run = (extra = []) => spawnSync("npm", ["ci", "--no-audit", "--no-fund", ...extra], {
    cwd: root,
    stdio: quiet ? "ignore" : "inherit",
    shell: true,
    env: {...process.env, npm_config_audit: "false", npm_config_fund: "false"}
  });

  if (!quiet) {
    console.log(`首次运行：先装两个依赖（${missing.map((m) => m.name).join(", ")}），约 5 秒，仅此一次…`);
  }
  let result = run();
  if (result.status !== 0) {
    if (!quiet) console.log(`默认源不通，换镜像：${MIRROR}`);
    result = run([`--registry=${MIRROR}`]);
  }

  const still = probeDeps();
  if (still.length === 0) {
    if (!quiet) console.log("依赖就绪，继续。");
    return true;
  }

  console.error("");
  console.error(`自动安装没成功，还缺：${still.map((m) => m.name).join(", ")}`);
  console.error("手动装（在 skill 目录里）:");
  console.error(`  npm ci --registry=${MIRROR}`);
  console.error("不装也能跑：①方向验证 ②选品决策 ③反查货源 问卷 与 1688 报价。");
  process.exit(2);
}
