# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-02

首个可交付版本：8 个平台 × 9 个法域，全部可出包。

### 新增

- **8 个平台的事实层**：Ozon、Яндекс Маркет、Wildberries、Shopee、Lazada、TikTok Shop、Amazon、noon。共 218 条事实，每条带 `source_url`、抓取时间、`final`/`candidate`/`unverified` 等级。
- **Яндекс Маркет** 平台支持（俄语区第二极）：标题最优 60–120 字符、图片 ≥200×200 且接受 webp/heic、上架费按卖家标价计算。
- **Amazon 模块化标题**：`item_name` ≤75 + `title_differentiation` ≤125 = 合计 200，2026-07-27 起生效。主标题超 75 时给出「拆到 Item Highlights」的提示，而不是判违规。
- **账号能力探测**（`npm run probe:account`）：用「参数必然非法但不落地数据」的请求探写权限，三态判定 `granted`/`denied`/`unknown`。
- **九法域税率参考**（`regions/<CC>/profile.json` 的 `tax_reference`）：俄罗斯 2026 年起 НДС 22%（联邦法 425-ФЗ）、阿联酋 5%、沙特 15%，其余标多源参考。只做提示，不参与计算。
- **九国公共假日**（`npm run holidays:probe`）：Google 官方公共假日日历 + Nager 交叉核对，覆盖 9/9 法域。
- **品类进口规模**（`npm run trade:probe`）：UN Comtrade 免 key 接口，取进口额、净重、中国份额、单价 $/kg。
- **noon 帮助中心全量采集**（`scripts/probe-noon-help.mjs`）：245 篇文章落地，标题上限 160、描述 250–4000、Partner SKU ≤50。
- **Wildberries 中文文档**：`seller.wildberries.ru/instructions/cn/ch/`，标题 ≤60 字符、图片最小 700×933、尺码表必须做进商品图片。
- 新增 `docs/信息源盘点.md`：七类通道的实测可用率与被墙原因。

### 变更

- **1:1 平台不再中心裁切**，改为等比缩放 + 白底补方（`contain-pad-white-v1`）。原实现会把 900×1200 的服装母版切掉上下各 150px（画面 25%），裙摆与领口正好在那两条带上。
- **Amazon 取消 1:1 假设**。官方 G1881 现行原文只约束「最长边 500–10,000 像素」，没有任何比例条款；原按 1:1 裁图是二手推断。现改为 `ratio_policy: preserve`，原图直出。
- **Amazon 图片数量**：撤回「上限 7 张」（二手转述）。官方只说「至少 1 张」「建议 6 张 + 1 视频」，未给上限。
- **平台就绪判定**不再看「有没有任意一条 final」，改看关键事实（图片比例 / 标题规则）的等级。此前这个缺陷让一个文档被封的平台被误判为可提交。
- **1:1 + 二手比例口径**不再一律判「待核」：补边方案下最坏结果是主体显小，不是违规，与裁切的风险性质不同。

### 修复

- 中文标题被「首字母大写」误杀（西里尔规则套用到中文）。
- 禁用字符 `"@ ^ * # &"` 被逐字符展开，分隔用的空格成了禁用字符，导致所有带空格的标题被判违规。
- 问卷里的尺码字段名被跨平台通用，等于用 A 平台的答案替 B 平台背书。
- 给 `regions/<CC>/profile.json` 加字段却没同步 schema，`additionalProperties: false` 导致整包生成失败。

## [0.1.0] - 2026-10-31

初始骨架：RU 法域、Ozon 单平台、母版内容与平台投影、27 项问卷、定价与台账。
