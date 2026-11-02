/**
 * 统一入口的测试。
 *
 * 只测「解析」与「文件名契约」——不跑整条链路：
 * 完整串跑要调市场数据、开子进程、出包，两分多钟，不适合放进测试套件。
 * 端到端靠人工冒烟（`npm run chain:dir`），这里守住两件容易悄悄坏掉的事：
 *   1. chain 报的缺项能不能被正确解析成「阻断出包」清单
 *   2. 三个脚本之间的文件名规则是否还一致
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractPackageDir, parseMissingFields, readHandoffBlockers, slugOf } from "../../scripts/run-direction.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// chain 真实输出的片段（2026-11-02 实测，未改一字）
const CHAIN_OUTPUT = `出包前先确认答卷：answers 来自 data/intake/RU-e5a5b3e5a3ab.json
缺少必答项，停止：
  - 缺 cost（number）：采购价多少？（人民币，不含运费）
  - 缺 package_dimensions_cm（number[]）：包装尺寸是多少？（长 × 宽 × 高，厘米；三个数字）
  - 缺 return_policy（string）：退货怎么处理？（谁承担运费、有没有本地退货地址、几天无理由）
完整清单：node scripts/intake.mjs --list`;

test("parseMissingFields：从 chain 的真实输出里取出 key 与问题", () => {
  const fields = parseMissingFields(CHAIN_OUTPUT);
  assert.deepEqual(fields.map((item) => item.key), ["cost", "package_dimensions_cm", "return_policy"]);
  assert.equal(fields[0].question, "采购价多少？（人民币，不含运费）");
  // 类型括号不能混进问题文本里，否则提示里会出现「（number）：…」
  assert.equal(fields[1].question.startsWith("包装尺寸"), true);
});

test("parseMissingFields：同字段重复只留一条（chain 可能两处都报）", () => {
  const text = `  - 缺 cost（number）：采购价多少？
  - 缺 cost（number）：采购价多少？`;
  assert.equal(parseMissingFields(text).length, 1);
});

test("parseMissingFields：没有缺项时返回空数组，不编造", () => {
  assert.deepEqual(parseMissingFields(""), []);
  assert.deepEqual(parseMissingFields("出包成功：package/xxx__123"), []);
  // 长相相近但不是缺项的行不该被吃掉
  assert.deepEqual(parseMissingFields("  - 警告 weight_g 偏高"), []);
});

test("slugOf：与 market-scan / select-candidates 的文件名规则一致", () => {
  // 这条是三个脚本之间的隐式契约。规则一变，run-direction 就读不到
  // 上游产出的 data/candidates/<region>-<slug>.json，而且报错只会说「候选为空」。
  assert.equal(slugOf("女士针织开衫"), "e5a5b3e5a3ab");
  assert.equal(slugOf("女士针织开衫"), Buffer.from("女士针织开衫", "utf8").toString("hex").slice(0, 12));
});

test("slugOf：真实候选文件确实按这个规则命名（不一致就是契约已破）", () => {
  const expected = join(ROOT, "data", "candidates", `RU-${slugOf("女士针织开衫")}.json`);
  assert.equal(existsSync(expected), true, `按 slug 拼出的路径不存在：${expected}`);
});

test("缺参数时打印用法并以 2 退出，不启动任何采集", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/run-direction.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20000
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /用法:/);
  // 参数错就不该有「方向验证」这类进展输出
  assert.equal(/① 方向验证/.test(result.stdout), false);
});

// ── 包目录提取：两种形态都要认 ────────────────────────
// 干净 clone 是「首次跑」，目录不带 __时间片。只认带后缀的那种，
// 在别人的机器上就会显示「包 见上」——等于没告诉人产物在哪。
const BS = String.fromCharCode(92); // 反斜杠，避免测试文件里出现转义噪音

test("extractPackageDir：已存在时的 <sku>__<时间片> 形态", () => {
  const line = `1. 打开 \`D:${BS}work${BS}package${BS}kurtka-x__604133/handoff.md\`，按「开工三步」往下做`;
  assert.equal(extractPackageDir(line), `D:${BS}work${BS}package${BS}kurtka-x__604133`);
});

test("extractPackageDir：首次跑时的 <sku> 形态（无时间片）", () => {
  const line = `1. 打开 \`/tmp/cb-v11/package/kurtka-zhenskaia-osenniaia-eac468/handoff.md\`，按`;
  assert.equal(extractPackageDir(line), "package/kurtka-zhenskaia-osenniaia-eac468");
});

test("extractPackageDir：相对路径形态", () => {
  assert.equal(extractPackageDir("package/sku__123/handoff.md"), "package/sku__123");
});

test("extractPackageDir：没有 handoff 路径时返回 null，不瞎猜", () => {
  assert.equal(extractPackageDir("出包成功：ozon、yandex-market"), null);
  assert.equal(extractPackageDir(""), null);
});

// ── 平台侧阻断：答卷填齐 ≠ 能上架 ─────────────────────
test("readHandoffBlockers：读出 BLOCKED 与逐条待办", async () => {
  const {mkdtemp, mkdir, writeFile} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "handoff-"));
  const dir = join(root, "package", "sku-x");
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, "handoff.md"), [
    "BLOCKED: 本包暂不可直接上架（2 项待解）",
    "  1. 待完成：须申请诚信标签 DataMatrix，每码不得复用。",
    "     怎么解：找服务商办。",
    "  2. 待完成：EAC 证书主体与报关主体必须一致。",
    "本包图片为占位图，仅用于验证流程",
    "# 人工交付说明"
  ].join("\n"), "utf8");

  const result = await readHandoffBlockers("package/sku-x", {root});
  assert.equal(result.blocked, true);
  assert.equal(result.headline, "本包暂不可直接上架（2 项待解）");
  assert.equal(result.items.length, 2);
  assert.match(result.items[0], /DataMatrix/);
  assert.match(result.items[1], /EAC/);
});

test("readHandoffBlockers：没有 BLOCKED 时不编造", async () => {
  const {mkdtemp, mkdir, writeFile} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "handoff-ok-"));
  const dir = join(root, "package", "sku-y");
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, "handoff.md"), "# 人工交付说明\n开箱即用\n", "utf8");

  const result = await readHandoffBlockers("package/sku-y", {root});
  assert.equal(result.blocked, false);
  assert.deepEqual(result.items, []);
});

test("readHandoffBlockers：目录不存在返回 null，不抛错中断链路", async () => {
  assert.equal(await readHandoffBlockers(null), null);
  assert.equal(await readHandoffBlockers("package/does-not-exist", {root: ROOT}), null);
});
