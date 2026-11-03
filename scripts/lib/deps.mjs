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
