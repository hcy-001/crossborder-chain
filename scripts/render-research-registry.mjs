#!/usr/bin/env node
/**
 * 把 data/research-registry.json 渲染成一份人读清单。
 *
 * 为什么要生成而不是手写：这份清单会随采集推进不断变状态，
 * 手写必然与真实状态脱节，最后变成"文档说已采、其实没采"。
 */
import {readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(await readFile(join(ROOT, "data/research-registry.json"), "utf8"));

const STATUS_LABEL = {
  final: "✅ 已取到（官方）",
  candidate: "🟡 已取到（待核）",
  unverified: "⬜ 未取到",
  paid: "💰 只有付费源",
  blocked: "🔒 需账号/授权",
  manual: "✍️ 人工取样"
};

const counts = {};
const all = registry.dimensions.flatMap((dimension) => dimension.items);
for (const item of all) counts[item.status] = (counts[item.status] ?? 0) + 1;

const lines = [
  "# 信息采集清单（脚本生成，勿手改）",
  "",
  `生成时间：${new Date().toISOString()}　条目：${all.length} 条　源文件：\`data/research-registry.json\``,
  "",
  "> 这一页回答的是「做跨境女装到底要看多少东西」。每一格都会改变结论；空着的不是不重要，是还没取到。",
  "",
  "## 一、总账",
  "",
  "| 状态 | 条数 |",
  "|---|---|",
  ...Object.entries(STATUS_LABEL).map(([status, label]) => `| ${label} | ${counts[status] ?? 0} |`),
  "",
  `合计 ${all.length} 条，其中可直接用于判断的（✅）${counts.final ?? 0} 条。`,
  ""
];

for (const dimension of registry.dimensions) {
  lines.push(`## ${dimension.id}. ${dimension.name}`, "", "| # | 要看什么 | 为什么影响结论 | 来源 | 状态 | 采集命令 |", "|---|---|---|---|---|---|");
  for (const item of dimension.items) {
    lines.push(`| ${item.id} | ${item.what} | ${item.why} | ${item.source} | ${STATUS_LABEL[item.status] ?? item.status} | ${item.collector && item.collector !== "—" ? `\`${item.collector}\`` : "—"} |`);
  }
  lines.push("");
}

lines.push(
  "## 二、还缺的那些，卡在哪",
  "",
  "| 类型 | 具体缺什么 | 怎么补 |",
  "|---|---|---|",
  "| 付费源 | 品类规模与增速、电商渗透率 | 采购第三方数据（Statista / 电商数据平台）；未采购前不得用别的数字替代 |",
  "| 需账号 | 平台必填属性与字典（Shopee / Lazada / TikTok / noon） | 申请 partner 凭证 + 店铺授权；Ozon 已通 |",
  "| 需登录 | Lazada 标题上限、noon 全部规则 | 登录 Seller Center 看商品编辑页，截图存档 |",
  "| 人工 | 价格带、热销榜、尺码实测 | `npm run signals:sample` 把抄来的数据变成工单 |",
  "| 公开文档未给 | Shopee 标题上限 | 只能查 Open Platform 的 item_name 字段定义；未核前不写数字 |",
  "",
  "## 三、纪律",
  "",
  "- **不猜**：拿不到就写未取到，不用「通常」「大约」。",
  "- **不顶替**：缺某国数据时不用邻国或往年数据填坑。",
  "- **不越级**：二手来源只能标 candidate，要升 final 必须有官方页面或接口实测。",
  "- **可复跑**：每条都写了采集命令；跑不动就是环境或凭证问题，不是数据不存在。"
);

await writeFile(join(ROOT, "docs/信息采集清单.md"), `${lines.join("\n")}\n`, "utf8");
console.log(`清单 ${all.length} 条 · ✅${counts.final ?? 0} 🟡${counts.candidate ?? 0} ⬜${counts.unverified ?? 0} 💰${counts.paid ?? 0} 🔒${counts.blocked ?? 0} ✍️${counts.manual ?? 0}`);
