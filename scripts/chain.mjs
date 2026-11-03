#!/usr/bin/env node
/**
 * 出包入口（薄壳）。
 *
 * 真正逻辑在 chain-main.mjs。这一层只做一件事：**先探依赖，缺了给人话**。
 *
 * 为什么必须分两层：ESM 的 import 是静态提升的，chain-main 一开头就 import 了
 * ajv 与 sharp。没跑过 npm ci 的人直接执行时，会得到
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'sharp'` 这种看起来「整个项目坏了」的报错，
 * 实际只是最后一段没装依赖 —— ①②③ 与问卷完全不依赖它们。
 */

import {ensureDeps, probeDeps} from "./lib/deps.mjs";

const USAGE = "node scripts/chain.mjs --category <品类> --region <法域> --candidates <N> --intake <answers.json>";

const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
const missing = probeDeps();

// 只看用法时不装依赖、也不加载主逻辑：主逻辑静态 import 了 ajv/sharp，
// 缺包时连 --help 都会崩，那是「问它怎么用却先报错」，最没道理的一种体验。
if (wantsHelp && missing.length > 0) {
  console.log(`出包入口（当前未装依赖：${missing.map((m) => m.name).join(", ")}，首次真正出包时会自动安装）

用法：
  ${USAGE}

其他参数：--mock-llm --mock-images（零成本试跑）、--tickets <目录>、--run-id <id>
完整说明见 README 的「安装」与「命令」两节。`);
  process.exit(0);
}

// 缺依赖时自动装一次（拖进 skills 目录的人不会先去终端敲 npm ci）
await ensureDeps({autoInstall: !wantsHelp});

// 依赖齐了才加载主逻辑
await import("./chain-main.mjs");
