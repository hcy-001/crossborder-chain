---
name: crossborder-chain
description: 跨境电商全链路单入口（选品→找货→生图→建模→上品信息）。用户只给大品类、目标法域、候选数量，链路先做信息自检，再吃选品技能产出的真实工单，按确定性打分排序，随后并行出图与建模，最后按目标法域的平台要求组装上品信息。覆盖 8 个平台（Ozon / Яндекс Маркет / Wildberries / Shopee / Lazada / TikTok Shop / Amazon / noon）× 9 个法域（RU SG MY TH PH ID VN AE SA），全部可出包。平台规则来自官方开放平台文档、卖家帮助中心（含中文站）、llms.txt 与存档页，每条事实带 source_url 与 final/candidate/unverified 等级。模型只做判别（选择/异常处置/现场推导），不做打分与定价。产出是「可被人接手提交」的材料包，不调用上架 API、不保存凭证、不自动提交。
version: 2.0.0
agent_created: true
user-invocable: true
disable-model-invocation: false
---

# 跨境电商全链路（单入口）

**这条链路只做一件事：把「一句话需求」变成一个可以被人接手提交的上品包，并且每一步都能被数字否掉。**

## 0. 唯一的开始方式

### 0.0 两条入口，先分清你手里有什么

卖家手里的东西不一样，入口就不能只有一个。

| 你手里有 | 从哪进 | 为什么 |
|---|---|---|
| **只有方向**（「我想做女装开衫，卖俄罗斯」） | **`npm run chain:dir -- --direction "..." --region RU`** | 一条命令跑完 ①②③④，并列出 ⑤ 还差什么 |
| 想逐步看每段在做什么 | 依次跑 `market:scan` → `select:candidates` → `quotes:1688` → `source:lookup` | 每段单独可调，输出更细 |
| 已经有货源（1688 链接 + 采购价） | 跳到 §0.1 答题 | 货已在手，直接算账 |

**顺序不能反。** 先有货再验证市场，是拿采购决策去倒推需求——方向不成立时，前面找货、比价、拍图的时间全废。正确顺序是：

```
方向 + 目标市场  →  市场验证（规模/季节/价格带）  →  方向成立  →  回国内反查货源  →  出包/上架
```

```bash
# 推荐：一条命令跑完 ①→④，并列出上架缺口（阻断出包 / 只挡上架 分开列）
npm run chain:dir -- --direction "女士针织开衫" --region RU
# 想直接看产出（仓库内 demo 答卷，每项标注 measured/estimated/demo）：
npm run chain:dir -- --direction "女士针织开衫" --region RU --intake data/intake/demo-ru.json

# 或者逐段手动跑：
npm run market:scan -- --direction "女士针织开衫" --region RU
# 产出 data/directions/RU-*.json + 屏幕结论：
#   品类码 6110（由「开衫」匹配）｜进口 $1.02B｜中国占 31.3%｜$24.72/kg
#   季节：低温月 ≥5，秋冬主战场，8–10 月上新
#   价格带：未取得（C 端不可达，不编）
#   结论：方向成立 → 下一步拿 sourcing.keywords_for_1688 反查货源
```

方向不成立就停在这一段，不进入答题，也不去找货。这一段的判据只有一条：**进口规模与中国份额能不能支撑一个 SKU 线**。

### 0.0.1 接着往下三段：选品 → 反查 → 出包

方向过了，依次跑这三条。前三段都不需要你手里有货，也不需要你填问卷。

```bash
# ② 选品决策：出 5–10 个候选，每个带依据 / 敏感性 / 自我查证
npm run select:candidates -- --direction "女士针织开衫" --region RU --count 8

# ③ 反查货源：把候选变成能直接询价的采购规格书（含目标进价上限）
npm run source:lookup -- --direction "女士针织开衫" --region RU --pick c01,c03

# ③-a 抓真实报价（需 922 上有已登录 1688 的 Chrome）：用实测报价复核毛利
npm run quotes:1688 -- --keyword "针织开衫" --target-price 71.6
```

| 段 | 读什么 | 产出 | 什么时候不准往下走 |
|---|---|---|---|
| ② | 方向简报 | `data/candidates/*.json` + 排序 | 方向结论是「证据不足」 |
| ③ | 候选 | `data/sourcing/*.json` + `docs/采购规格书-*.md` | 候选为空 |

② 的候选**不是「市场验证过的爆款」**，是「按已知约束枚举出的合理选项」，每条都写清了哪条证据是硬的、哪条是二手的、哪个假设破了就废。排序依据是依据强度，不是销量预测。

③ 给的是**目标进价上限**（售价扣佣金、履约、目标毛利后倒推）。高于这个价就没有毛利空间，不用去谈。倒推用的三个假设写在 `scripts/source-lookup.mjs` 的 `ASSUMPTIONS` 里，改完重跑即可；真实佣金与运费须从后台和货代报价单抄，脚本不替你猜。

③-a 会把这个上限**拿去和真实报价对撞**：抓 1688 搜索列表，算「目标价以内有几家」以及按 P25/中位/P75 进价的实际毛利。没有这条数据时，规格书只给上限，不判断「拿不拿得到货」——两者是不同的问题。

> ⚠️ 1688 的搜索关键词必须按 **GBK** 编码（表单 `acceptCharset=GBK`）。用 `encodeURIComponent`（UTF-8）会搜出无关商品，而页面看起来「有结果」。唯一允许拼该 URL 的地方是 `channels/source/ali1688.mjs` 的 `buildSearchUrl`；仓库内测试会扫全文拦截这类写法。

拿到真实报价之后，用 `marginAt({priceCny, costCny})` 复核实际毛利，再决定要不要进 ④ 出包。

### 0.1 方向成立之后：先问，再跑

**只拿「品类 + 法域 + 候选数」就开跑，等于替卖家在尺码、计费重、佣金、税费、退货上做决定**——错一项，货到不了买家手里，或者到了也是亏的。

```bash
node scripts/intake.mjs --list        # 1. 打印必问清单（29 项：必答 16 / 需确认 11 / 可默认 2）
node scripts/intake.mjs --list --how   #    同上，每项追加「从哪拿 / 抄什么 / 查不到怎么办」
node scripts/intake.mjs --guide        #    只打印获取手册；同内容见 docs/信息需求清单.md
# 2. 把答复存成 answers.json（键名见清单），先校验：
node scripts/intake.mjs --check --answers answers.json      # 缺必答项 exit 2，并点名缺哪几条
# 3. 带答案跑链路（缺必答项时价格不出、只出包）
node scripts/chain.mjs --category 女装 --region RU --candidates 1 --intake answers.json
```

**必答 16 项**（缺任何一项直接 exit 2，不出包也不出价）：平台、**账号状态**、**平台尺码字段名**、尺码体系、尺码数值、包装后重量、包装尺寸（体积重）、成本、国际运费、平台佣金率、税率、支付费率、退货政策、认证、品牌授权、面料成分。
**需确认 11 项**（可默认，但用了默认要留痕）：履约方式、保险与申报价、本地化程度、模特使用、凭证路径、权限范围、发布模式、图床类型与地址等。**可默认 2 项**：回款币种、提交方式。

清单真源是 `core/intake/checklist.mjs`（每条都带「为什么问」与「没答会怎样」），改清单就改那一个文件。

```bash
# 零成本自检（离线、占位图、建模只做规则校验）
node scripts/chain.mjs --category 女装 --region RU --candidates 3 --mock-llm --mock-images

# 真实产出（会用真模型判别、真供应商出图；建模默认仍只做计划）
node scripts/chain.mjs --category 女装 --region RU --candidates 2
```

> 所有命令都在**工程根目录**执行，或把 `scripts/chain.mjs` 换成绝对路径。脚本内部一律按自身位置解析路径，与 cwd 无关。

退出码：`0` 完成（含降级）｜`2` 输入或前置不成立｜`3` 有候选失败｜`4` 机械门未过。

### 0.1 数据从哪来（调用前先认这张表）

| 事实 | 出处 | 等级 | 拿不到时 |
|---|---|---|---|
| 汇率 | `data/sources.json` → CBR 官方镜像 + 交叉校验，TTL 24h | official | 标高 `stale`，**不出价** |
| 尺码体系与平台字段 | `regions/<CC>/sizing.json`；字段名由卖家一次性核对后填入 | **pending_seller**（公开接口 403 + 开发者文档反爬，未在无账号条件下核实） | 映射照做但标 `needs_field_confirmation`，不得声称可直接上架 |
| 费率/税额 | `regions/<CC>/cost-policy.json`（只声明必填项） | **unverified** | 价格 `unavailable` 并点名缺哪项 |
| 合规规则 | `regions/<CC>/compliance/rules.json` | secondary | 合规清单标 `unverified` |
| 平台规格 | `data/specs/platforms/<p>.json` | mixed（图片 official / 标题模板 unverified） | 未验的模板只出 `candidate` 稿 |
| 体积重 | 本链路默认 除数 6000（行业常规），可用 `volumetric_divisor` 覆盖 | 常规口径 | 缺包装尺寸 → 只用实重并标 `volumetric_unknown` |
| 选品信号 | 选品技能工单（`kind=sourcing_ticket`） | secondary 快照 | 工单缺失直接 `exit 2` |

一句话：**平台侧（图片/标题/数量/费用）已有大量官方原文，法定侧（税费/认证/进口要求）仍多为二手或未核**。所以交付里不写"已核实"，只写"这条事实的等级 + 出处 + 抓取时间"——`final` 才可当依据，`candidate` 必须留人核。


## 1. 它是什么 / 不是什么

是：一条**有模型参与的流水线**。模型在这里不是打字机，它做四件机器做不了的事——读懂堆在工单里的二手信号、在搜索结果里认哪条是同款、把「地点」推成光位与焦段、在失败时决定重试还是换路。这些决定的产物是**受 schema 约束的结构化对象**，可以被校验、被拒绝、被回放。

不是：一个「输入商品 → 输出图片」的函数。也不是「让模型自由发挥」——打分、定价、内容寻址、裁切这些必须可复现的地方，模型一次都不参与（见 §6）。

## 2. 六段流程与每段判据

| 段 | 动作 | 完成判据 | 失败时 |
|---|---|---|---|
| 0 自检 | `doctor` 机械健康检查 + 判别点 `information_audit` 排动作优先级 | doctor 硬失败即 `exit 2`；审计产出 `actions[]` 至少一条 | 硬失败不启动，绝不带病跑 |
| 1 采集 | 读选品技能的真实工单 `kind=sourcing_ticket`（含货源链接、价格、克重、信号、设计元素） | 工单数 > 0；目录缺失时报告缺哪个目录 | 采集为空 → `exit 2`，并写 `status=no_data` 回执 |
| 2 排序 | `core/selection` 归一 + `core/signals` 确定性打分 | 同输入两次 `input_sha256` 与排序结果完全一致 | 无候选即停，不伪造候选 |
| 3 找货 | 工单已有货源链接则直接用；缺成本时由 `cost_estimate` 判别能否估算 | 有 `cost`/`weight` 事实；估算必带 `source_kind=estimated` + 依据 | 匹配不到主供 → `unavailable`，只出包不出价 |
| 3.5 人群 | 判别点 `persona_assign` 指派人群；`core/persona/gate.mjs` 复算 falsifier 并封顶 `decision` | 指派必须有证据编号；`hypothesis` 只能靠探索配额进 `test`；配额账写回执 | 未指派 → 不写三组字段，封顶到 `observe` |
| 4 生产 | **并行**：一条线出图出包（9 张 AI 图 + 1 张数据驱动的尺码示意图），另一条线展陈渲染（默认只做计划） | 包内 9 张 900×1200 + `master/size/size-card.png` + 平台投影 + `handoff.md`；渲染自报 `product_in_scene` 与 `listing_contribution` | 两条线各自降级，互不阻塞 |
| 5 上品信息 | 组装 `input/<sku>.json` 并过 schema，再进 `runPackage` | schema 校验通过；`title_status` / `copy_status` 如实标注 | 缺文案标 `copy_status=unavailable`，不填空串 |

## 3. 十个判别点（模型做决定的地方）

| 判别点 | 决定什么 | 被什么否决（`block`） | 回退 |
|---|---|---|---|
| `information_audit` | 哪些事实该刷新、缺口优先级 | 引用了不存在的事实键 | 由机械健康检查直接生成动作清单 |
| `market_profile` | 目标市场的人像档、配色、场景池 | 年龄区间越界；无 `studio` 仅告警 | 按品类给保守档 |
| `sourcing_match` | 搜索结果里哪条同款、谁当主供 | 编造 ref；主供数量 ≠ 1；同时入选又排除 | 取第一张无风险标记的图 |
| `cost_estimate` | 能否估算成本/克重、依据是什么 | 非正数；依据无证据类型；估算标 `high` | **拒绝估算**，只出包不出价 |
| `shoot_plan` | 地点 → 光位/焦段/机位/动作 | 进深放不下该焦段；主图位非 studio；无道具却坐下 | 棚拍 + 北向漫射 + 合法焦段组合 |
| `ref_roles` | 谁是准绳、谁只核对结构、谁必须排除 | hero 不唯一/不存在/与 reject 重叠 | 取第一张无风险标记的图 |
| `platform_mapping` | 平台没规格时现场推一份候选 | **自称 official**；发明属性键 | 按最保守公开口径取值并标 `unverified` |
| `copy_pitch` | 目标语文案 | 绝对化用语；无出处数字；超长 | 无模板时**留空**并标 unavailable |
| `persona_assign` | 这条候选是给哪个已注册人群的 | 指派无证据；没算 falsifier；自称 `validated` | 一律 `unassigned`，不猜人群 |
| `exception_triage` | 失败后重试/放大/换图/降级 | 尺寸问题选 abort；放大目标低于供应商下限 | 按失败类型给确定性处置 |

每点的**回退实现都必须过自己的 schema**（`G3-JUDGE` 门强制），所以「降级」不会变成「换个形状糊过去」。

### 3.1 四条不许破的接口约定

这四条都是被真实故障打出来的，改任何一条都会让判别层静默退回模板：

| 约定 | 为什么 | 守它的地方 |
|---|---|---|
| 输出契约从 schema 现算，附在 system 末尾 | schema 要 `actions[].target`、system 只说「给出行动」时，模型会合理地写成 `keys/reason`，白烧一次调用还被拒收 | `describeSchema()` + `run.mjs`，`tests/judge/contract.test.mjs` |
| 通道对象绑定时不得丢接口（`complete` / `selftest`） | 只透传 `run` 会让判别层按 `complete` 判成「未配置」，于是每次判别都静默回退，回执还写「降级：无」 | `bound()`，`tests/channels/select.test.mjs` |
| 降级与证据等级从**台账**算，不从配置猜 | 通道「配好了」不等于「跑通了」；0 次模型返回写成 L2 就是等级夸大 | `chainDegradations()` / `judgeEvidenceLevels()`，`tests/chain/stages.test.mjs` |
| 出图角色先于拍摄 brief 说了算 | 白底主图要求 no people、brief 却带 persona/action，模型只挑一条执行：主图变模特摆拍、特写变半身人像 | `BRIEF_POLICY`，`tests/channels/imagegen-prompt.test.mjs` |
| schema 不过先修一轮再回退 | 模型答「白皙」（2 字）就被 `minLength:3` 打回整点回退，值其实是对的；一次语言相关的挑剔不该让模型的决定作废 | `judgePoint` 修复轮（错误原样递回，只修不动形状），`tests/judge/run.test.mjs` |

商品身份（品名/颜色/材质/人群/品牌）同理必须一路带到出图提示词：只给品类词，模型画出来的就不是货源那件衣服。

### 3.2 尺码：同一个 SKU，两个平台是两种结构

这是跨境最容易"看起来填好了、实际上不了架"的地方——**同一张尺码表，两个平台字段完全不同**：

| | Ozon | Wildberries |
|---|---|---|
| 结构 | 属性字典里的**集合型**值（`Российский размер` #4295，必填）：多码用 `;` 串成一格（`42;44`），卡片显示区间 | 独立的 `sizes[]` 数组 |
| 字段 | 实测：`size_attribute` #4295（必填，字典 835）+ 尺码表属性 `Таблица размеров JSON` #13164 + `Рост`/`Размер производителя` 等；该类目**没有**国际尺码属性 | `techSize` + `wbSize`（平台自有码表） |
| 多码 | 一个字段装多个码（集合语义），不用拆 SKU | 一卡多码，拆卡会拆散评论与销量 |
| 本地化 | 俄码为主，国际码仅对照 | 同左，但拒因里常见"尺码标注不合俄罗斯标准" |

所以链路不"生成一份尺码"就完事，而是**逐平台映射**：`core/sizing/adapt.mjs` 把通用表映射成各平台结构，结果写进 `package/<sku>/platforms/<id>/size-mapping.json`，并在回执里记 `size_mappings`。

三条纪律：
1. **俄码为准，国际码只作对照**；俄码↔国际码对照表属行业惯例而非官方标准，没取到就留空（`unverified`），不编；
2. **拿不到该平台的字段定义就 `blocked`** 并写 `missing`，不猜字段名；
3. **没有尺码行就 `blocked`**，不用空表头凑一个"填过了"；
4. **字段名不猜，而且开局就问**：`platform_size_field` 是必答项 —— 开店的人上架时天天见这个名字，留在事后补就是设计错误。答 `unknown` 是明确表态（允许没账号），答具体名字则视为已确认。

确认方式（不用手改 JSON）：

```bash
npm run sizing:confirm            # 问 4 个问题，回车沿用当前值
npm run sizing:confirm -- --dry   # 只预览会写什么
npm run sizing:confirm -- --reset # 撤回确认，回到 pending_seller
```

四个问题问的都是**后台里显示的字段名**：Ozon 的尺码属性（如 `Российский размер`）、Ozon 的国际尺码属性、WB 变体表里的技术尺码（如 `techSize`）、WB 自有尺码位（如 `wbSize`）。看不到的项直接回车留空，系统不拿别的码冒充。

没有卖家账号时：找代运营/招商经理要一份后台截图或商品模板（Ozon/WB 的模板 Excel 里就写着这些字段名），照着跑一次 `--set` 即可；在拿到之前保持 `pending_seller`，出包照常，只是不声称可直接上架。

## 4. 命令与参数
```bash
node scripts/chain.mjs --category <品类> --region <法域> --candidates <n> [选项]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--category` | 必填 | 大品类，进入文案与判别的上下文 |
| `--region` | 必填 | 目标法域两位码，必须已存在于 `regions/` |
| `--candidates` | `3` | 产出成品包的候选数（1–10） |
| `--profile` | `conservative` | 打分画像 `conservative｜aggressive｜pilot` |
| `--tickets` | 选品技能导出目录 | 直接指定工单目录 |
| `--skills-root` | `~/.workbuddy/skills` | 三个能力 skill 的安装根目录 |
| `--mock-llm` | 关 | 用判别桩，不联网 |
| `--mock-images` | 关 | 用占位图通道，不产生费用 |
| `--dry-modeling` | **开** | 建模只做计划与规则校验 |
| `--render-modeling` | 关 | 建模真渲染（需浏览器与建模 skill 依赖） |
| `--run-id` | 自动 | 复用指定运行号，便于复现 |
| `--explore-quota` | `2` | 本次运行允许多少个「人群仍是假设」的候选豁免封顶进 `test`；用尽即封顶 |
| `--intake` | 无 | 上架前问卷答复（`scripts/intake.mjs` 产出）。不给就只能出包、不能出价 |
| `--help` | — | 打印用法 |

配套命令：

```bash
node scripts/llm-probe.mjs --out out/verification/llm-probe.json   # 判别/视觉通道连通性实测
node scripts/selfgrade.mjs                                        # 七项自评（不过则 exit 1）
node scripts/gates/check-decouple.mjs                             # 七道机械门
node scripts/chain-evidence.mjs --run <run_id>                    # 实跑 → 证据（JSON + Markdown）
node scripts/lookbook.mjs --run <run_id>                          # 实跑 → 可翻看的成品质检页
npm run quickstart                                                # 零 key 一条命令跑通并指路 handoff
npm run evals                                                     # 评测集：毛利口径 / 尺码映射 / 缺项点名
npm run ozon:rules                                                # 拉平台字段规则 → docs/商品字段说明书.md
node scripts/chain-evidence.mjs --run <run_id>                    # 实跑 → 证据（JSON + Markdown）
node scripts/lookbook.mjs --run <run_id>                          # 实跑 → 可翻看的成品质检页
```

## 5. 降级矩阵

| 缺什么 | 表现 | 证据等级 |
|---|---|---|
| 判别 key | 全部判别走确定性回退，链路照常完成 | L1 |
| 生图 key | 9 张占位图，`handoff.md` 第二行声明不可投放 | L1 |
| 参考图目录 | `ref_roles` 标 `skipped_no_reference`，不做分级 | L1 |
| 浏览器 / 建模依赖 | 建模 `status=planned` 或 `unavailable`，生图不受影响 | L0/L1 |
| 网络 | FX 标 `stale` + 过期天数，包照出，价格标 `unavailable` | L1 |
| 工单目录缺失 | **不降级**，直接 `exit 2` 并写明缺哪个目录 | — |

原则：**能力缺失可以降级，输入缺失不许降级**。把「没接上」说成「市场没有机会」是最坏的一种谎。

## 6. 明确不做的事

- 不打分：`scoreCategories` 只吃确定性的维度向量，模型不参与（同输入两次逐字节一致）。
- 不出价：缺运费/税费/佣金任一组件时，价格一律 `pricing.status=unavailable`。
- 不翻译：拿不到目标语言的标题/文案就不写，标 `untranslated_or_missing` / `copy_status=unavailable`。
- 不提交：不调平台 API、不存商户凭证、不自动上架。
- 不冒充：占位图标 `placeholder`；候选规格标 `candidate`/`unverified`；估算标 `estimated`。

## 7. 产物清单

```
runs/<run_id>/
  chain.receipt.json        段状态、降级、判别汇总、token 账、证据等级
  chain.md                  人读的链路回执
  candidates.json           候选与打分（确定性）
  judgments/<point>--<scope>.json   判别台账：prompt 哈希、输入、原始返回、冲突、结论
data/personas.json          人群假设注册表（3 条假设，每条必带 falsifier）
input/<sku>.json            过 schema 的上品输入（含 persona / positioning / creative_brief）
package/<sku>/              母版 9 图 + 平台投影 + 校验 + 交接说明（handoff.md）
package/<sku>/platforms/<id>/size-mapping.json  该平台的尺码字段映射（拿不到字段就 blocked + 缺什么）
assets/3d/<sku>/            展陈渲染：design.json（派生材质）+ plan.json + hero/detail/eye.png
```

### 为什么不做商品三维（主动取舍）

展陈渲染的产物**对"上架材料"贡献为 0**：平台要的是商品图与尺码表，不是场景图。实测两条硬事实——① 它的几何是建模技能的固定展位（含技能内置招牌），商品本体不在场景里；② 9 张上架图全部来自图像模型，包内没有任何地方引用 `assets/3d/`。所以默认只做**建模计划**（`--dry-modeling` 开），`--render-modeling` 是显式选项，回执里写 `listing_contribution: none`。

替代方案不是"少做一件事"，而是**把位置让给真能进详情页的图**：`core/sizing/card.mjs` 用工单尺码表直接画一张 900×1200 的尺码示意图（`master/size/size-card.png`）。它 100% 数据驱动、每个数字可追到 `size.rows`；没有尺码行就不出图，manifest 记 `size_card.status=skipped` + 原因。

**展陈渲染的边界要当面说清**：本地这条线渲染的是**基准展位空间**——几何复用建模技能的 `zoomcare-pillbox` 预设，招牌文案、材质观感都由该技能的 `scene.html` 固定；我们只把市场配色写进 `design.json`。商品本体**不在**场景内，回执里以 `product_in_scene: false` + `modeling_note` 明写。

实测记录（2026-10-29，两次真实渲染对比）：`design.json` 的材质色从 `#e3d9c6 / #1c1c1e` 换成 `#f5f1ea / #8a9a8b` 后，`hero.png` 抽样 8319 点里仅 297 点变化 >2（最大差 39），画面观感未变——**色值很可能不参与渲染**，未做像素级定论，故标 `unverified`。要商品级三维资产得走 `product_3d`（需外部三维模型 key），当前链路默认不跑。

## 8. 怎么判断它做完了

`node scripts/selfgrade.mjs` 七项全 100 才算工程完成；平台侧提交（G14）与商品一致性未验之前，**不得**说「可直接上架」。判据定义见 `docs/quality-rubric.md`。

## 9. 扩展方式（改配置，不改代码）

| 想加什么 | 改哪里 | 是否需要动 `core/` |
|---|---|---|
| 新法域 | `regions/<CC>/`（`npm run add-region -- --id=XX` 生成四文件） | 否（`git diff` 可证） |
| 新平台 | `data/specs/platforms/<p>.json`；缺规格时链路会现场推候选 | 否 |
| 新汇率源 | `data/sources.json` 加一条 | 否 |
| 新判别点 | `core/judge/points.mjs` 注册 + `tests/judge/points.test.mjs` 加拒绝路径用例 | 是（判别点属领域逻辑） |
| 新能力 skill | `scripts/lib/skills.mjs` 的 `SKILL_NAMES` + 一处 probe | 否 |
