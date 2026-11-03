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

import {assertDeps} from "./lib/deps.mjs";

const USAGE = "node scripts/chain.mjs --category <品类> --region <法域> --candidates <N> --intake <answers.json>";

assertDeps({
  fallback:
    "不装也能跑：①方向验证（market:scan）、②选品决策（select:candidates）、"
    + "③反查货源（source:lookup）、问卷（intake）与报价（quotes:1688）。",
  usage: USAGE
});

// 依赖齐了才加载主逻辑
await import("./chain-main.mjs");
