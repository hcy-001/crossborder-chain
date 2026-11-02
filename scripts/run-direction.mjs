#!/usr/bin/env node
/**
 * 一个方向进去，一条命令跑完 ①→④，并把 ⑤ 需要的东西列成清单。
 *
 * 之前这条链要手动敲四条命令，中间还得自己抄文件路径：
 *   market:scan → select:candidates → quotes:1688 → source:lookup → chain
 * 定位写的是「一个方向进去」，那就得真的只有一个入口。
 *
 * ── 设计取舍 ────────────────────────────────────────
 * 这里用子进程复用现有 CLI，不 import 它们的 main —— 那些脚本顶层就会执行，
 * import 会绕过参数校验直接跑一遍。代价是要解析退出码，但隔离更干净。
 *
 * **每段有判据，不过就停**，不往下糊：
 *   ① 方向不成立    → 停，不选品（选出来也是白选）
 *   ② 候选为空      → 停
 *   ③ 报价未取到    → 继续，但明确标注「未与真实报价对撞」
 *   ④ 出包失败      → 停
 *
 * 用法：
 *   node scripts/run-direction.mjs --direction "女士针织开衫" --region RU
 *   ... --count 8 --pick c01 --quotes --intake <已有答卷.json>
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return true;
  return value;
}

/**
 * 从 chain 的「缺项」输出里解析出阻断出包的字段。
 *
 * 为什么不自己维护一份必答清单：那份清单与 chain 里的真实校验必然漂移，
 * 漂移那天分类就是错的，而且错得没有提示。直接读它报的，永远同步。
 *
 * 格式：`  - 缺 cost（number）：采购价多少？（人民币，不含运费）`
 */
export function parseMissingFields(text) {
  const out = [];
  for (const matched of String(text ?? "").matchAll(/^\s*-\s+缺\s+([a-z_]+)（[^）]*）：(.+)$/gm)) {
    if (!out.some((item) => item.key === matched[1])) {
      out.push({key: matched[1], question: matched[2].trim()});
    }
  }
  return out;
}

function usage() {
  console.log(`一个方向 → 一个可提交包（串跑 ①②③④，并列出 ⑤ 还差什么）

用法:
  node scripts/run-direction.mjs --direction <方向词> --region <法域码> [选项]

选项:
  --count <n>       候选数量（默认 6，允许 5–10）
  --pick <c01,c02>  指定候选出规格书（默认取排序第一）
  --quotes          真去 1688 抓报价（需 922 上有已登录 Chrome）；不加则跳过
  --keyword <词>    抓报价用的关键词（默认取方向词）
  --intake <file>   已有答卷；不给就生成骨架（只含能自动填的字段）
  --skip-chain      只跑 ①②③，不出包（调试用）

退出码: 0 全通 | 2 参数错 | 3 方向不成立 | 4 候选为空 | 5 出包失败`);
}

/** 跑一条子命令，返回 {code, stdout, stderr}。用 process.execPath，不吃 PATH 差异。 */
function run(scriptRelPath, args, { label, allowFail = false, exitCode = 1 } = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, scriptRelPath), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300000,
    env: {...process.env, NO_PROXY: "127.0.0.1,localhost"}
  });
  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (code !== 0 && !allowFail) {
    console.error(`\n✗ ${label} 失败（退出码 ${code}）`);
    const detail = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
    if (detail) console.error(detail);
    process.exit(exitCode);
  }
  return { code, stdout, stderr };
}

/** 从输出里捞关键结论，避免把子命令全部输出重贴一遍。 */
function pickLines(text, patterns) {
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    if (patterns.some((p) => p.test(line))) out.push(line.trim());
  }
  return out;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function slugOf(text) {
  // 与 market-scan / select-candidates 保持同一套文件名规则：UTF-8 字节的十六进制
  return Buffer.from(String(text), "utf8").toString("hex").slice(0, 12);
}

/**
 * 生成答卷骨架。
 *
 * 只填「链路自己算得出来的」，其余留 null 并在 questions 里点名。
 * 铁律：能算的必须算，算不出来的必须说清「找谁要」——
 * 把该干的活变成人的作业，是这套工具最容易犯的错。
 */
async function buildIntakeSkeleton({ region, direction, candidate, quotes, existing }) {
  const profile = JSON.parse(await readFile(join(ROOT, "regions", region, "profile.json"), "utf8"));
  const sizing = await readFile(join(ROOT, "regions", region, "sizing.json"), "utf8")
    .then(JSON.parse).catch(() => null);

  const answers = {...(existing?.answers ?? {})};

  // ── 链路能算的：直接填，来源写在 auto_filled 里 ──
  const auto = {};
  const setAuto = (key, value, source) => {
    if (value === null || value === undefined || value === "") return;
    if (answers[key] !== undefined && answers[key] !== null && answers[key] !== "") return; // 人填过的优先
    answers[key] = value;
    auto[key] = source;
  };

  // 平台：法域声明的平台里取第一个；用户可以改
  const platform = (profile.platforms ?? [])[0] ?? null;
  setAuto("platform", platform, "regions/<CC>/profile.json（法域声明的平台）");
  setAuto("target_language", region === "RU" ? "俄语" : "英语", "法域默认");
  setAuto("currency_and_payout", profile.currency ?? null, "法域结算币种");
  setAuto("vat_rate", profile.tax_reference?.standard_rate ?? null,
    `regions/<CC>/tax_reference（${profile.tax_reference?.status ?? "未核"}）`);
  setAuto("size_system", sizing?.system ?? null, "regions/<CC>/sizing.json");

  // 方向词里能判断的：性别
  if (/女/.test(direction)) setAuto("gender", "女", "方向词");
  else if (/男/.test(direction)) setAuto("gender", "男", "方向词");

  // 候选能给的：材质、颜色、克重
  if (candidate) {
    const materialMap = {
      acrylic: "腈纶 70% 以上",
      wool_blend: "羊毛 30–50% + 腈纶",
      wool: "羊毛 70% 以上"
    };
    setAuto("material_composition", materialMap[candidate.material] ?? null, "候选材质档");
    // 克重取规格区间的中值：写区间会让定价算不了，写单值并注明来源
    const weightRange = {acrylic: [280, 360], wool_blend: [320, 420], wool: [380, 480]}[candidate.material];
    if (weightRange) {
      setAuto("weight_g", Math.round((weightRange[0] + weightRange[1]) / 2),
        `候选材质档的克重区间 ${weightRange[0]}–${weightRange[1]}g 取中值`);
    }
    if (candidate.color_cn) setAuto("color", candidate.color_cn, "候选配色");
  }

  // 成本：真实报价中位优先，其次 P25；没有报价就留空
  if (quotes?.summary?.price) {
    const p = quotes.summary.price;
    setAuto("cost", Math.round(p.median * 10) / 10,
      `1688 实测报价中位（P25 ${p.p25?.toFixed(1)} / P75 ${p.p75?.toFixed(1)}，${quotes.summary.priced} 条）`);
  }

  // ── 只有卖家/后台知道的：不猜，列出来 ──
  const questions = [];
  const ask = (key, question, where) => {
    if (answers[key] !== undefined && answers[key] !== null && answers[key] !== "") return;
    questions.push({key, question, where});
  };

  ask("credentials_path", "平台凭证（.env）放在哪个文件？", "你自己保管；不要贴进对话");
  ask("credentials_scope", "这把 key 是只读还是读写？", "不确定就让 probe:account 探");
  ask("publishing_mode", "出包后人工提交，还是让工具提交？", "默认人工提交");
  ask("platform_commission_rate", "该类目平台佣金率是多少？", "卖家后台 → 费率页（东/西不同类目）");
  ask("international_shipping_fee_cny", "跨境头程每件多少钱？", "货代报价单");
  ask("return_policy", "退货政策怎么设？", "按平台规则 + 你的承受力");
  ask("fulfillment", "履约方式（FBO / FBS / 海外仓）？", "决定库存与时效");
  ask("certs", "该类目需要哪些认证（ЕАС / СТ-1 等）？", "平台类目要求 + 检测机构");
  ask("brand_authorization", "有品牌授权吗？还是走无品牌？", "有授权填授权，没有则用「无品牌」字典值");
  ask("image_host_kind", "商品图放哪（自有对象存储 / CDN / 店铺图床）？", "平台只收公网 URL");
  ask("image_host_base_url", "图床 URL 前缀是什么？", "拼上文件名就能访问的那种");
  ask("package_dimensions_cm", "包装尺寸（长×宽×高 cm）？", "实测；填小会被罚，填大会多付仓储费");

  return {
    generated_at: new Date().toISOString(),
    direction,
    region,
    note: "auto_filled 是链路自己算的（有来源）；questions 是只有你知道的。"
      + "填完 questions 再跑一次 chain，才能出「可提交包」。",
    auto_filled: auto,
    answers,
    questions
  };
}

async function main() {
  const direction = flag("direction");
  const regionRaw = flag("region");
  if (!direction || direction === true || !regionRaw || regionRaw === true) {
    usage();
    process.exit(2);
  }
  const region = String(regionRaw).toUpperCase();
  const count = Number(flag("count", 6));
  const pick = flag("pick", null);
  const withQuotes = Boolean(flag("quotes", false));
  const quoteKeyword = flag("keyword", direction);
  const intakePath = flag("intake", null);
  const skipChain = Boolean(flag("skip-chain", false));

  const started = Date.now();
  console.log(`一个方向 → 可提交包`);
  console.log(`方向：${direction} ｜ 法域：${region} ｜ 候选：${count}\n`);

  // ── ① 方向验证 ─────────────────────────────────────
  console.log("① 方向验证");
  const market = run("scripts/market-scan.mjs", ["--direction", String(direction), "--region", region], {
    label: "方向验证",
    exitCode: 3 // 方向段失败 → 3，与「方向不成立」同一语义：问题在最上游
  });
  for (const line of pickLines(market.stdout, [/品类码|需求|款级|价格带|季节|结论/])) {
    console.log(`   ${line}`);
  }
  // 方向不成立就停。选出来也是白选 —— 这是链路第一道判据。
  if (/结论[:：].*(不成立|证据不足)/.test(market.stdout)) {
    console.error("\n✗ 方向结论为「不成立 / 证据不足」，停止。理由见上面一行，不进入选品。");
    process.exit(3);
  }

  // ── ② 选品决策 ─────────────────────────────────────
  console.log("\n② 选品决策");
  const candidates = run("scripts/select-candidates.mjs",
    ["--direction", String(direction), "--region", region, "--count", String(count)],
    { label: "选品决策", exitCode: 4 });
  const topLines = pickLines(candidates.stdout, [/^\s{2}c\d{2}/]);
  console.log(`   产出 ${topLines.length} 条候选`);
  for (const line of topLines.slice(0, 3)) console.log(`   ${line}`);

  const candidatesPath = join(ROOT, "data", "candidates", `${region}-${slugOf(direction)}.json`);
  const candidateDoc = await readFile(candidatesPath, "utf8").then(JSON.parse).catch(() => null);
  const pool = candidateDoc?.candidates ?? [];
  if (pool.length === 0) {
    console.error(`\n✗ 候选为空（${candidatesPath} 不存在或没有 candidates），停止。`);
    process.exit(4);
  }

  // ── ③ 报价（可选）────────────────────────────────
  console.log("\n③ 反查货源");
  let quotes = null;
  if (withQuotes) {
    const quoteRun = run("scripts/scan-1688-quotes.mjs",
      ["--keyword", String(quoteKeyword)],
      { label: "1688 报价", allowFail: true });
    if (quoteRun.code === 0) {
      const quotesFile = join(ROOT, "data", "market", `1688-quotes-${today()}.json`);
      quotes = await readFile(quotesFile, "utf8").then(JSON.parse).catch(() => null);
      for (const line of pickLines(quoteRun.stdout, [/报价|最低|≤ 目标|结论/])) console.log(`   ${line}`);
    } else {
      // 报价抓不到不属于「该停」：后半段仍能出包，但结论里必须标注「未对撞」
      console.log(`   ⚠ 报价未取到（退出码 ${quoteRun.code}）。继续出包，但「拿不拿得到货」标为未验证。`);
      const tail = (quoteRun.stderr || quoteRun.stdout).trim().split("\n").slice(-3).join("\n");
      if (tail) console.log(`   ${tail.replaceAll("\n", "\n   ")}`);
    }
  } else {
    console.log("   本次不抓新报价（加 --quotes 才抓；需 922 上有已登录的 Chrome）");
  }

  // 没抓新报价时，仍读最近一次落盘的结果 —— 否则 cost 填不进去，
  // 明明有 55 条实测报价却让用户手填采购价，等于把已有的数据浪费掉。
  if (!quotes) {
    const dir = join(ROOT, "data", "market");
    const names = await readdir(dir).catch(() => []);
    const latest = names.filter((name) => /^1688-quotes-.*\.json$/.test(name)).sort().at(-1);
    if (latest) {
      quotes = await readFile(join(dir, latest), "utf8").then(JSON.parse).catch(() => null);
      if (quotes) console.log(`   用已有报价：${latest}（${quotes.summary.priced} 条，${quotes.fetched_at?.slice(0, 10)}）`);
    }
  }

  const pickArg = pick && pick !== true ? String(pick) : pool[0].id;
  const sourcing = run("scripts/source-lookup.mjs",
    ["--direction", String(direction), "--region", region, "--pick", pickArg],
    { label: "采购规格书", exitCode: 4 });
  for (const line of pickLines(sourcing.stdout, [/零售|真实报价|结论|产出|人读版/])) {
    console.log(`   ${line.replace(/^\s+/, "")}`);
  }

  const pickedCandidate = pool.find((item) => item.id === pickArg) ?? pool[0];

  // ── 答卷骨架 ───────────────────────────────────────
  const existing = intakePath && intakePath !== true
    ? await readFile(resolve(String(intakePath)), "utf8").then(JSON.parse).catch(() => null)
    : null;
  const skeleton = await buildIntakeSkeleton({
    region, direction: String(direction), candidate: pickedCandidate, quotes, existing
  });
  const skeletonPath = join(ROOT, "data", "intake", `${region}-${slugOf(direction)}.json`);
  await mkdir(dirname(skeletonPath), { recursive: true });
  await writeFile(skeletonPath, `${JSON.stringify(skeleton, null, 2)}\n`, "utf8");
  console.log(`\n答卷：自动填了 ${Object.keys(skeleton.auto_filled).length} 项，还差 ${skeleton.questions.length} 项人答`);
  console.log(`   骨架：${skeletonPath.replaceAll("\\", "/")}`);

  if (skipChain) {
    console.log("\n（--skip-chain：停在 ④ 之前）");
    process.exit(0);
  }

  // ── ④ 出包 ─────────────────────────────────────────
  console.log("\n④ 出包");
  const chain = run("scripts/chain.mjs",
    ["--category", String(direction), "--region", region, "--candidates", "1", "--mock-images",
      "--intake", skeletonPath],
    { label: "出包", allowFail: true });
  const chainOk = chain.code === 0;
  // 出包失败时**不能直接退出**：那正是最需要看「还差什么」的时刻。
  // 先汇总，再由成功与否决定退出码。
  const packageLine = chainOk ? (pickLines(chain.stdout, [/package_dir|产出|交付说明/])[0] ?? "") : "";
  // chain 把包路径写在「下一步：打开 `<path>/handoff.md`」里，路径分隔符随平台变化（/ 或 \\）
  const packageDir = chainOk
    ? ((chain.stdout.match(/package[\\/][A-Za-z0-9_\-]+__\d+/) ?? [])[0] ?? null)
    : null;
  if (chainOk && packageLine) console.log(`   ${packageLine.replace(/^\s+/, "")}`);
  if (!chainOk) {
    console.log(`   ✗ 未出包（退出码 ${chain.code}）：答卷缺项，见下方「阻断出包」清单`);
  }

  // ── ⑤ 结论与差项 ───────────────────────────────────
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${"─".repeat(56)}`);
  console.log(`完成（${elapsed}s）`);
  console.log(`  ① 方向    成立`);
  console.log(`  ② 候选    ${pool.length} 条，选 ${pickedCandidate.id}`);
  console.log(`  ③ 报价    ${quotes ? `${quotes.summary.priced} 条实测（起批价）` : "未取（加 --quotes）"}`);
  const packageName = packageDir ? packageDir.split(/[\\/]/).pop() : null;
  console.log(`  ④ 包      ${packageName ? `package/${packageName}/handoff.md` : "见上"}`);
  // 缺口分两类。分类**直接取自 chain 的校验结果**，不另外维护一份必答清单 ——
  // 硬编码的清单迟早与 chain 里的真实校验漂移，那时分类就是错的。
  const blocking = parseMissingFields(`${chain.stderr}\n${chain.stdout}`);
  const forPublish = skeleton.questions.filter(
    (q) => !blocking.some((item) => item.key === q.key)
  );
  console.log(`  ⑤ 上架    还差 ${skeleton.questions.length} 项人答`);
  if (blocking.length > 0) {
    console.log(`      阻断出包（${blocking.length} 项，填完才能出包）：`);
    for (const q of blocking) console.log(`        · ${q.key} — ${q.question}`);
  } else {
    console.log(`      出包所需已齐`);
  }
  if (forPublish.length > 0) {
    console.log(`      只挡上架（${forPublish.length} 项，包可以先出）：`);
    for (const q of forPublish) console.log(`        · ${q.key} — ${q.question}（${q.where}）`);
  }
  console.log("");
  if (chainOk) {
    console.log(`下一步：补「只挡上架」那几项，然后按 package 里的 handoff 提交；填完再跑本命令复核。`);
  } else {
    console.log(`下一步：填 ${skeletonPath.replaceAll("\\", "/")} 的 answers（先填「阻断出包」），再跑本命令。`);
  }
  process.exit(chainOk ? 0 : 5);
}

// 只有被直接执行才跑 main。被 import 时（测试要拿 parseMissingFields / slugOf）
// 不能触发整条链路 —— 否则 import 一下就真的去搜市场、出包了。
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`失败：${error.message}`);
    process.exit(1);
  });
}
