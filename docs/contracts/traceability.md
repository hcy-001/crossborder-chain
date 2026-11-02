# 规格追踪表

> 每条实现必须对应一个规格来源和一个可运行判据。验证级别：L0 静态 / L1 本地 / L2 真实平台。

## 不变式

| 不变式 | 实现落点 | 机械判据 |
|---|---|---|
| I1 region 配置化 | regions、core/config、scripts/add-region | G1-CORE + G3 git diff |
| I2 平台只投影 | adapters/platforms | G12 master 文案 diff 为空 |
| I3 打分确定性 | core/signals | G8 同输入逐字节一致 |
| I4 外部事实四元组 | schemas/fact、core/data | G1-FACT + schema 契约测试 |
| I5 TTL 与过期可见 | core/data、scripts/doctor | G5 fake clock + 故障 channel |
| I6 降级仍出包 | core/package、channels | G6 + unavailable/placeholder 检查 |
| I7 合规不代办、价格可归因 | core/compliance、core/pricing | 禁用语扫描 + G9 归因闭合 |

## 阶段

| 阶段 | 主交付 | 写者 | 证据目录 |
|---|---|---|---|
| P0 总纲 | 架构、模块边界、三项风险 | 主 agent | out/P0 |
| P1 数据治理 | 在线 FX、事实信封、TTL、快照接口 | data-builder | out/P1 |
| P2 能力接入 | mock 生图、OpenAI 兼容 probe、LAB | channel-builder | out/P2 |
| P3 信号与品类 | 确定性五维打分与三画像排名 | signal-builder | out/P3 |
| P4 合规 | RU 女装外套准入 + 追溯 | compliance-builder | out/P4 |
| P5 内容与投影 | package schema、master、两个平台投影 | content-builder | out/P5 |
| P6 解耦门 | 四检查与绿/红 fixture | gate-builder | out/P6 |

## 门表修订后口径

| 门 | 对应测试/命令 | 级别 | 证据路径 | 状态 / 未完成原因 |
|---|---|---|---|---|
| G1 | `npm run check:decouple` + gate fixtures | L1 | `out/verification/final-abc-gates.txt`、`tests/gates/decouple.test.mjs` | 通过：CORE 7 / PATH 192 / FACT 17 / PROFILE 9 / SOURCES 4 |
| G2 | 网络访问静态扫描（core 禁裸网络） | L1 | `out/verification/gate-evidence.json`、`tests/gates/network.test.mjs` | 通过：G2-NET 扫 core 7 文件、0 违规；红/绿 fixture 各一 |
| G3 | `npm run add-region -- --id=XX` + git diff | L1 | `tests/integration/add-region.test.mjs` | 通过：生成四文件、core diff 为空 |
| G4 | 新增同形源只改 sources.json；异协议须新增 adapter | L1 | `tests/data/source-channels.test.mjs`、`tests/gates/config-extension.test.mjs` | 通过：同形源配置-only；未注册 adapter 抛 `ADAPTER_UNAVAILABLE` |
| G5 | 模拟超时/无数据，检查 stale/missing/expiredDays | L1 | `tests/data/` | 通过 |
| G-FX | 汇率多源池与自动回退 | L1 | `tests/data/refresh-facts.test.mjs`、`out/verification/fx-expand-doctor.json` | 通过：4 个币对各 ≥2 个独立源；`priority` 定序；官方失败自动换下一源；`secondary` 只补空白不覆盖既有事实，且强制标 `pricing.quality=secondary` |
| G6 | 零 key + 联网 `npm run demo` | L1 | `out/verification/online-demo.json`、`out/verification/package-check.json` | 通过：exit 0、9 张 900×1200、18/18 核对 |
| G7 | 同协议换 base URL/model/key 只改配置；异协议新增 channel | L2 | `out/verification/realgen-l2-evidence.json`、`tests/channels/imagegen-real.test.mjs`、`tests/channels/imagegen-prompt.test.mjs` | 已对火山方舟 `doubao-seedream-5-0-260128` 真实出图 11 次；9 张母版 900×1200、aHash 无重复、回执记真实通道。**遗留：输入无 colour 事实导致 9 张色差，prompt 已修但未重跑；单价未查证** |
| G8 | score 双跑 byte diff | L1 | `out/P3/score.json`、`out/verification/block3-evidence.json` | 通过：两跑哈希相同，改输入后 `input_sha256` 改变 |
| G9 | 同 snapshot 双跑 + 换 snapshot 归因 | L1 | `out/P1/pricing.json` | 通过：归因和与总差额 gap=0；`fx` 进 components 判 `fx_misplaced` |
| G10 | 新环境 `npm ci` → doctor → demo → pack | L1 | `out/verification/baseline-npm-ci.log`、`out/verification/online-*.json` | 本机通过：`npm ci` exit 0 后全链 exit 0 |
| G11 | 无 image key、无浏览器模板合成 | L1 | `tests/content/content-pipeline.test.mjs`、`out/verification/block5-content.json` | 通过：mock 出 9 图、视频空目录不阻塞 |
| G12 | 三平台文案 diff + crop.json 溯源 | L1（架构） | `tests/content/content-pipeline.test.mjs`、`tests/compliance/region-degradation.test.mjs` | **部分完成**：投影与 12.5% 中心裁切已证；真实第三平台规格未建（无可核验来源，不编造） |
| G13 | 内容寻址幂等与像素变化 | L1 | `out/P3/storage.json` | 通过：同内容同名、改内容改名改 SHA |
| G14 | 无作者在场的人工平台提交记录 | L2 | 无 | **未执行**：需另一人按 handoff 在真实卖家后台提交一次 |

G14 未执行前，对外只能说“本地跑通”，不能说“包可以直接贴”。

## 法域完成度（2026-10-29 实测）

| 法域 | completion | 合规规则 | 平台规格 | 定价 |
|---|---|---|---|---|
| RU | full | `regions/RU/compliance/rules.json`（secondary，未官方核验） | ozon / wildberries | 可用（USD_CNY 6.6664，TTL 内） |
| SA | skeleton | 缺 | 缺 | `unavailable`（缺 SAR 已核汇率） |
| AE | skeleton | 缺 | 缺 | `unavailable`（缺 AED 已核汇率） |
| SG / MY / TH / VN / PH / ID | skeleton | 缺 | 缺 | `unavailable` |

`completion=full` 由 `G1-PROFILE` 机械强制：缺规则或缺平台规格直接判红，不允许空壳自称完整。

## 全链路（chain）追踪

单入口 `scripts/chain.mjs` 把选品、找货、出图、建模、上品信息串成一条命令。它引入模型判别，因此需要额外说明「不变式没有被削弱」。

| 不变式 | 在链路里的维护方式 | 判据 |
|---|---|---|
| I3 打分确定性 | 打分只吃 `core/selection` 归一的维度向量；判别结果**不进** `score.json` | 双跑 `input_sha256` 与排序一致（`tests/chain/stages.test.mjs`） |
| I4 事实四元组 | 成本/克重来自货源页则标 `reported` 并落 `pricing_facts`（含 `source_url` / `ttl_hours`）；估算标 `estimated` + 依据 | `G1-FACT` + `tests/chain/stages.test.mjs` |
| I6 降级仍出包 | 判别回退、占位图、无建模环境均不阻塞出包；建模与出图并行、互不拖死 | `tests/integration/chain-offline.test.mjs` |
| I7 不代办、价格可归因 | 链路不提交平台；缺运费税费即 `pricing unavailable`；判别层被禁止自称官方规格 | `platform_mapping` 的 `llm_claims_official` 拒绝路径 |
| I9 人群不冒充 | 人群指派必须有证据编号；`status` 枚举里没有 `observed/validated`；`hypothesis` 一律由 gate 封顶，唯一出口是当次探索配额 | `tests/persona/gate.test.mjs` + `tests/judge/points.test.mjs`（拒绝路径）+ 回执 `persona_gate` 账 |
| I8 无静默失效 | 判别通道按 `complete()` 判可用，绑定时接口不得丢；降级与证据等级一律从台账 `by_source` 反算 | `tests/channels/select.test.mjs` + `tests/chain/stages.test.mjs`（正反两例）+ 自评第 3 项 `interface_checks` |

| 新增门 | 内容 | 判据 | 级别 |
|---|---|---|---|
| G3-JUDGE | 判别层不得自己联网/import 通道；每个判别点必须有 `build/check/fallback`、正整数版本、布尔 `binding`、协议正文；**回退输出必须过自身 schema** | `node scripts/gates/check-decouple.mjs` 输出 `G3-JUDGE PASS ... fallbacks_schema_ok=N` | L1 |
| G-LLM | 判别与视觉通道真实连通性（一次最小调用，带 usage） | `npm run llm:probe` exit 0，证据 `out/verification/llm-probe.json` | L2 |
| G-SELFGRADE | 七项自评（瑕疵定义见 `docs/quality-rubric.md`） | `npm run selfgrade` exit 0，证据 `out/verification/selfgrade.json` | L1 |

| 链路阶段 | 实现 | 判别点 | 未完成 / 边界 |
|---|---|---|---|
| 自检 | `runDoctor` + `information_audit` | 排动作优先级 | 机械结论仍是真源，判别只做排序与解释 |
| 采集 | `scripts/lib/skills.mjs` 读选品工单 | — | 工单是**历史快照**（`source_type=secondary`）；空目录直接 exit 2 |
| 排序 | `core/selection` + `core/signals` | — | 全部确定性 |
| 找货 | `core/sourcing/match.mjs` | `sourcing_match`、`cost_estimate` | 无货源链接即 `unavailable`，不拿近似款顶替 |
| 生产 | `runPackage` + `core/modeling` | `ref_roles`、`shoot_plan`、`exception_triage` | 参考图视觉判读需视觉通道；无通道只做几何探测并标 `vision=false` |
| 上品信息 | `core/listing` + `runPackage` | `platform_mapping`、`copy_pitch` | 平台规格仍 `unverified` 时不出 `title.txt`；缺文案标 `unavailable` |

