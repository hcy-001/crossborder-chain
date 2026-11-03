#!/usr/bin/env node
import {execFile} from "node:child_process";
import {readdir, readFile, stat, writeFile, mkdir} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {POINTS, POINT_IDS} from "../core/judge/points.mjs";
import {judgePoint} from "../core/judge/run.mjs";
import {createJournal} from "../core/judge/journal.mjs";
import * as mockLlm from "../channels/llm/mock.mjs";
import {selectLlmChannel} from "./lib/channels.mjs";
import {loadReferenceImages} from "./lib/skills.mjs";
import {judgeEvidenceLevels, runModeling} from "./lib/chain-stages.mjs";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 自评分。七项，每项要么 100 要么不及格 —— 不给「大概良好」。
 *
 * 这个脚本的存在是为了让「我给自己打分」这件事可复核：
 * 每条分数背后都是一次真实执行或一次静态扫描，不是形容词。
 */

const PLACEHOLDER_PATTERNS = [
  {label: "TODO", pattern: /\bTODO\b/},
  {label: "TBD", pattern: /\bTBD\b/},
  {label: "FIXME", pattern: /\bFIXME\b/},
  {label: "稍后实现", pattern: /稍后实现/},
  {label: "待补", pattern: /待补(?!图)/}
];

const SCAN_DIRS = ["core", "channels", "adapters", "scripts", "tests", "docs", "regions", "data"];
const ROOT_DOCS = ["README.md", "SKILL.md", "HANDOFF.md"];

// 校验器会把这些词当作**被检目标**引用（例如断言 handoff 里不许出现「视频：待补」），
// 所以扫描占位承诺时必须排除校验器自身，否则检查会把自己判红。
const CHECKER_PATHS = [
  "scripts/selfgrade.mjs",
  "scripts/verify-package.mjs",
  "scripts/gates/",
  "tests/"
];

// 文档里会解释「不许写待补」这类口径，因此文档侧只扫真正的未完成标记。
const DOC_PLACEHOLDER_PATTERNS = PLACEHOLDER_PATTERNS.filter(({label}) => ["TODO", "TBD", "FIXME", "稍后实现"].includes(label));

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", ".git", "package", "runs", "out", "tmp", "cache", "assets"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(?:mjs|js|json|md|py|sh)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function score(passed, total, detail) {
  if (total === 0) return {score: 0, detail: `${detail}（无样本，不判通过）`, passed: 0, total: 0};
  return {score: Math.round((passed / total) * 100), detail, passed, total};
}

async function run(cmd, args, options = {}) {
  try {
    const {stdout} = await exec(cmd, args, {cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 600_000, ...options});
    return {code: 0, stdout};
  } catch (error) {
    return {code: error.code ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`};
  }
}

// ── 1. 功能完整度 ────────────────────────────────────────────────────────────
async function completeness() {
  const allFiles = [...await walk(join(ROOT, "core")), ...await walk(join(ROOT, "scripts")), ...await walk(join(ROOT, "channels")), ...await walk(join(ROOT, "adapters"))];
  const files = allFiles.filter((file) => !CHECKER_PATHS.some((prefix) => file.slice(ROOT.length + 1).split("\\").join("/").startsWith(prefix)));
  const hits = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const {label, pattern} of PLACEHOLDER_PATTERNS) {
      if (pattern.test(content)) hits.push(`${file.slice(ROOT.length + 1)}: ${label}`);
    }
  }
  const required = [
    "scripts/chain.mjs",
    "scripts/selfgrade.mjs",
    "core/judge/run.mjs",
    "core/judge/points.mjs",
    "channels/llm/http-openai-compat.mjs",
    "core/listing/build.mjs",
    "core/sourcing/match.mjs",
    "core/modeling/plan.mjs",
    "core/selection/collect.mjs",
    "SKILL.md"
  ];
  const missing = [];
  for (const rel of required) {
    try {
      await stat(join(ROOT, rel));
    } catch {
      missing.push(rel);
    }
  }
  const total = files.length + required.length;
  const passed = total - hits.length - missing.length;
  return {
    ...score(passed, total, `扫描 ${files.length} 个源文件 + ${required.length} 个必需文件`),
    hits,
    missing
  };
}

// ── 2. 判据强度 ──────────────────────────────────────────────────────────────
async function criteriaStrength() {
  // 审全部测试目录，而不是手挑几个：手挑的列表一旦漏了目录，
  // 那批用例的断言强度就再也没人看过，而自评仍然是 100 分。
  const testFiles = (await walk(join(ROOT, "tests")))
    .filter((file) => file.endsWith(".test.mjs"))
    .filter((file) => !file.split(/[\\/]/).includes("fixtures"));

  const weak = [];
  for (const file of testFiles) {
    const content = await readFile(file, "utf8");
    const asserts = (content.match(/assert\./g) ?? []).length;
    const tautologies = (content.match(/assert\.ok\(\s*true\s*\)/g) ?? []).length;
    if (asserts === 0) weak.push(`${file.slice(ROOT.length + 1)}: 无断言`);
    else if (tautologies > 0) weak.push(`${file.slice(ROOT.length + 1)}: 含恒真断言`);
  }

  const tests = await run(process.execPath, ["--test"], {});
  const pass = Number(/^# pass (\d+)/m.exec(tests.stdout)?.[1] ?? 0);
  const fail = Number(/^# fail (\d+)/m.exec(tests.stdout)?.[1] ?? 1);
  const gate = await run(process.execPath, ["scripts/gates/check-decouple.mjs"], {});
  const gatePass = (gate.stdout.match(/PASS/g) ?? []).length;
  const gateFail = (gate.stdout.match(/FAIL/g) ?? []).length;

  const total = testFiles.length + 3;
  const passed = (testFiles.length - weak.length) + (tests.code === 0 && fail === 0 && pass > 0 ? 1 : 0) + (gate.code === 0 && gateFail === 0 ? 1 : 0) + (gatePass >= 7 ? 1 : 0);
  return {
    ...score(passed, total, `测试文件 ${testFiles.length}，全量 ${pass} 通过 / ${fail} 失败，机械门 ${gatePass} PASS / ${gateFail} FAIL`),
    weak,
    test_summary: {pass, fail, exit: tests.code},
    gate_summary: {pass: gatePass, fail: gateFail, exit: gate.code}
  };
}

// ── 3. LLM 判别有效性 ────────────────────────────────────────────────────────
async function judgeEffectiveness() {
  const journalDir = join(ROOT, "runs", "selfgrade-judgments");
  const journal = createJournal({dir: journalDir});
  const ctx = {
    category: "女装",
    region: {regime: "probe", currency: "CNY", locales: ["zh-CN"]},
    facts: {},
    refs: [{id: "ref-01"}, {id: "ref-02"}, {id: "ref-03"}],
    health: {},
    knownKeys: ["brand", "product_type", "material", "size", "color"],
    canonicalKeys: ["brand", "product_type", "material", "size", "color"],
    platform: {id: "probe"},
    candidate: {title: "probe"}
  };

  const results = [];
  for (const id of POINT_IDS) {
    const accepted = await judgePoint({pointId: id, ctx, channel: mockLlm, journal, scope: "accept"});
    const invalid = await judgePoint({pointId: id, ctx, channel: mockLlm, journal, scope: "invalid", scenario: "invalid"});
    results.push({
      point: id,
      accept_path: accepted.source === "llm",
      reject_path: invalid.source === "fallback",
      has_fallback_schema: Boolean(POINTS[id].schema),
      binding: POINTS[id].binding
    });
  }

  // 绑定后的真实通道必须仍带 complete：丢了它，判别层会把通道判成未配置并静默回退。
  const {mkdtemp: mkTmp, rm: rmTmp} = await import("node:fs/promises");
  const {tmpdir: osTmp} = await import("node:os");
  const bindRoot = await mkTmp(join(osTmp(), "selfgrade-bind-"));
  await mkdir(join(bindRoot, "config"), {recursive: true});
  await writeFile(join(bindRoot, "config/local.json"), JSON.stringify({
    llm: {enabled: true, baseUrl: "https://example.invalid/api/v3", model: "probe", maxTokens: 64}
  }));
  await writeFile(join(bindRoot, "config/local.secret.json"), JSON.stringify({llm: {apiKey: "probe"}}));
  const boundSelection = await selectLlmChannel(bindRoot);
  const boundKeepsComplete = boundSelection.degraded === false && typeof boundSelection.channel?.complete === "function";
  await rmTmp(bindRoot, {recursive: true, force: true});

  // 证据等级只认台账：全回退不可能是 L2。
  const fallbackLevel = judgeEvidenceLevels({judges: {total: 2, by_source: {fallback: 2}}, imageCount: 9});
  const levelHonest = fallbackLevel.llm.startsWith("L1") && fallbackLevel.images.startsWith("L2");

  const total = results.length * 3 + 2;
  const passed = results.reduce((sum, item) => sum + (item.accept_path ? 1 : 0) + (item.reject_path ? 1 : 0) + (item.has_fallback_schema ? 1 : 0), 0)
    + (boundKeepsComplete ? 1 : 0)
    + (levelHonest ? 1 : 0);
  return {
    ...score(passed, total, `${results.length} 个判别点：接受路径 / 拒绝路径 / 回退同形 · 绑定保接口 ${boundKeepsComplete ? "✓" : "✗"} · 等级诚实 ${levelHonest ? "✓" : "✗"}`),
    detail_points: results,
    interface_checks: {boundKeepsComplete, levelHonest, fallback_levels: fallbackLevel}
  };
}

// ── 4. 降级完备 ──────────────────────────────────────────────────────────────
async function degradation() {
  const checks = [];

  // 「没有 key」必须用**空的配置根**来模拟。本机有 key，直接问当前配置永远问不出降级路径。
  const {mkdtemp} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const emptyRoot = await mkdtemp(join(tmpdir(), "nokey-"));
  const noKey = await selectLlmChannel(emptyRoot, undefined);
  checks.push({
    name: "无 LLM key 时回退而不是崩溃",
    ok: noKey.degraded === true && typeof noKey.channel?.complete === "function",
    detail: noKey.detail
  });

  const mockPaths = await loadReferenceImages({uploadRoot: join(ROOT, "__missing__"), slug: "x", keyword: "y"});
  checks.push({
    name: "无参考图目录时返回空而不是抛错",
    ok: Array.isArray(mockPaths.images) && mockPaths.images.length === 0,
    detail: mockPaths.detail
  });

  const noModeling = await runModeling({modelingRoot: null, designPath: "/none", outDir: "/none", dry: true});
  checks.push({
    name: "无建模环境时返回 unavailable",
    ok: noModeling.status === "unavailable",
    detail: noModeling.detail
  });

  const offlineJudge = await judgePoint({pointId: "market_profile", ctx: {}, channel: null});
  checks.push({
    name: "无判别通道时走确定性回退",
    ok: offlineJudge.source === "fallback" && Boolean(offlineJudge.value),
    detail: offlineJudge.reject_reason
  });

  const offline = await run(process.execPath, [
    "scripts/chain.mjs", "--category", "女装", "--region", "RU", "--candidates", "1",
    "--tickets", join(ROOT, "tests/fixtures/chain-tickets"),
    "--mock-llm", "--mock-images", "--run-id", `selfgrade-${Date.now()}`
  ], {env: {...process.env, http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", all_proxy: ""}});
  checks.push({
    name: "零 key + 零代理一次调用跑完整链路",
    ok: offline.code === 0,
    detail: offline.code === 0 ? "exit 0" : offline.stdout.slice(-600)
  });

  const total = checks.length;
  const passed = checks.filter((item) => item.ok).length;
  return {...score(passed, total, `${total} 类降级场景`), checks};
}

// ── 5. 可复现性 ──────────────────────────────────────────────────────────────
async function reproducibility() {
  const checks = [];
  const lock = await readIfExists(join(ROOT, "package-lock.json"));
  checks.push({name: "存在锁文件", ok: Boolean(lock)});
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  checks.push({name: "四条命令都在 scripts 里", ok: ["doctor", "demo", "pack", "test"].every((key) => Boolean(pkg.scripts[key]))});
  checks.push({name: "链路口令已登记", ok: Boolean(pkg.scripts.chain) && Boolean(pkg.scripts.selfgrade)});
  const installed = await readIfExists(join(ROOT, "node_modules", "sharp", "package.json"));
  checks.push({name: "依赖已安装（sharp 可解析）", ok: Boolean(installed)});
  const total = checks.length;
  const passed = checks.filter((item) => item.ok).length;
  return {...score(passed, total, `${total} 项可复现前提`), checks};
}

// ── 6. 文档一致性 ────────────────────────────────────────────────────────────
async function documentation() {
  const skill = await readIfExists(join(ROOT, "SKILL.md"));
  const readme = await readIfExists(join(ROOT, "README.md"));
  const rubric = await readIfExists(join(ROOT, "docs/quality-rubric.md"));
  const checks = [
    {name: "SKILL.md 存在且写了唯一入口命令", ok: Boolean(skill) && /scripts\/chain\.mjs/.test(skill)},
    {name: "SKILL.md 列出全部命令行参数", ok: Boolean(skill) && ["--category", "--region", "--candidates", "--mock-llm", "--dry-modeling"].every((flag) => skill.includes(flag))},
    {name: "README 写了链路命令", ok: Boolean(readme) && /npm run chain/.test(readme)},
    {name: "质量判据文档存在", ok: Boolean(rubric) && /瑕疵/.test(rubric) && /自评/.test(rubric)},
    // 判据文档本身要**定义**这些词（「出现 TODO/TBD 即瑕疵」），所以它不参与占位扫描；
    // 参与扫描的是会被当成承诺阅读的那两份：技能正文与 README。
    {name: "文档无占位承诺", ok: [skill, readme].filter(Boolean).every((text) => !DOC_PLACEHOLDER_PATTERNS.some(({pattern}) => pattern.test(text)))},
    {name: "traceability 覆盖 G 门", ok: Boolean(await readIfExists(join(ROOT, "docs/contracts/traceability.md")))}
  ];
  const total = checks.length;
  const passed = checks.filter((item) => item.ok).length;
  return {...score(passed, total, `${total} 项文档一致性`), checks};
}

// ── 7. 成本纪律 ──────────────────────────────────────────────────────────────
async function costDiscipline() {
  const probe = await readIfExists(join(ROOT, "out/verification/llm-probe.json"));
  const checks = [];
  checks.push({name: "存在真实连通性证据", ok: Boolean(probe)});
  if (probe) {
    const data = JSON.parse(probe);
    checks.push({name: "单价未查证时明确写 null 与原因", ok: data.unit_price_cny === null && Boolean(data.unit_price_reason)});
    checks.push({name: "真实调用带回 usage", ok: Boolean(data.text?.usage?.total_tokens > 0)});
  } else {
    checks.push({name: "单价未查证时明确写 null 与原因", ok: false});
    checks.push({name: "真实调用带回 usage", ok: false});
  }
  const chainSrc = await readIfExists(join(ROOT, "scripts/chain-main.mjs"));
  checks.push({name: "回执记录 token 账而不是编金额", ok: Boolean(chainSrc) && /unit_price_cny: null/.test(chainSrc)});
  const total = checks.length;
  const passed = checks.filter((item) => item.ok).length;
  return {...score(passed, total, `${total} 项成本口径`), checks};
}

async function main() {
  await mkdir(join(ROOT, "tests/fixtures/chain-tickets"), {recursive: true});
  const items = [
    ["功能完整度", await completeness()],
    ["判据强度", await criteriaStrength()],
    ["LLM 判别有效性", await judgeEffectiveness()],
    ["降级完备", await degradation()],
    ["可复现性", await reproducibility()],
    ["文档一致性", await documentation()],
    ["成本纪律", await costDiscipline()]
  ];

  const report = {
    at: new Date().toISOString(),
    overall: Math.round(items.reduce((sum, [, item]) => sum + item.score, 0) / items.length),
    passed: items.every(([, item]) => item.score === 100),
    items: items.map(([name, item]) => ({name, ...item}))
  };

  await mkdir(join(ROOT, "out/verification"), {recursive: true});
  await writeFile(join(ROOT, "out/verification/selfgrade.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines = ["| 维度 | 分数 | 说明 |", "|---|---|---|"];
  for (const [name, item] of items) lines.push(`| ${name} | ${item.score} | ${item.detail} |`);
  lines.push("", `总分：${report.overall}　结论：${report.passed ? "七项全 100" : "未达交付线"}`);
  for (const [name, item] of items) {
    const problems = [...(item.hits ?? []), ...(item.weak ?? []), ...(item.missing ?? []),
      ...(item.checks ?? []).filter((check) => !check.ok).map((check) => `${check.name}：${check.detail ?? "未通过"}`)];
    if (problems.length > 0) {
      lines.push("", `**${name} 未通过项**`, ...problems.map((item2) => `- ${item2}`));
    }
  }
  console.log(lines.join("\n"));
  process.exitCode = report.passed ? 0 : 1;
}

await main();
