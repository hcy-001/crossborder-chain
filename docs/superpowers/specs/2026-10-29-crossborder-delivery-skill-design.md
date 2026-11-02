# 跨境电商交付包 Skill 设计

> 状态：施工基线 ｜ 建档：2026-10-29 ｜ 结论级别：L0（静态设计）
>
> 规格来源：`参赛提示词本体_20261028.md`、`研发资料与信息源_20261028.md`。

## 1. 目标与边界

输入 `region + category`，可选 `budget / positioning / source_goods`，输出可人工提交到目标平台的 `package/<sku>/` 与 `handoff.md`。系统完成上架前的选品、货源信息整理、合规告知、内容生产、平台投影与价格归因，不持有商户凭证、不调用上架接口、不代提交。

首条演示链路固定为 `RU + 女装外套 + 无货源`。RU、SA、AE 建完整 profile；SEA 六国只建配置骨架，未核规则写 `unverified`，不得用推测补齐。

### 本轮已改口径

- 交付演示条件为 **零 key + 联网**，不再是零 key + 断网。
- 联网用于刷新汇率、平台公开规则和公开信号；mock 只替代生图，不替代外部事实。
- 断网出完整包不作为验收条件。来源失败、过期和缺失仍通过模拟故障测试，防止旧数据静默冒充新数据。
- 第三方 T+1 数据必须标实际时点和延迟，不称“实时”。

## 2. 方案裁决

| 方案 | 结论 | 取舍 |
|---|---|---|
| 单仓分层模块化单体 | **采用** | 与四条 npm 命令、现有 `.mjs` 资产和 8 天施工窗口一致；模块边界由机械门维护 |
| 九法域独立流水线 | 否决 | 会复制变量、合规与交付逻辑，违反 region 配置化 |
| 微服务或多仓库 | 否决 | 增加部署与凭证复杂度，无对应验收收益 |

技术基线：Node.js `>=20`、ESM `.mjs`、`node:test`、JSON Schema 2020-12、Ajv、Sharp。除 npm 包外不依赖本机软件；密钥只读环境变量。

## 3. 分层与依赖

```text
cli/                 composition root：组装配置、端口与运行状态
core/                纯领域逻辑；不知地区、平台、域名、网络与本机路径
adapters/            平台字段映射、标题拼装、图片裁切与交付校验
channels/            imagegen / storage / source 外部能力，唯一允许联网的位置
data/                specs / variables / sources.json / conflicts.json
regions/             9 个法域 profile 与合规规则
scripts/             doctor、demo、pack、机械门、扩展生成器
schemas/             配置、事实、运行、交付包的机器校验契约
tests/               单元、契约、故障注入与集成测试
runs/<runId>/         状态、变量快照、回执；不入 git
out/P<n>/             各阶段真实输出与证据
package/<sku>/        商品交付包；不入 git
```

允许依赖：`core <- adapters <- channels`；`cli/` 与 `scripts/` 是组合根，可组装三者。禁止 `core/` import 平台 SDK、通道或网络客户端；禁止业务脚本绕过 `channels/` 发请求。

## 4. 核心模块契约

| 模块 | 职责 | 输入 | 输出 |
|---|---|---|---|
| `core/config/load-profile.mjs` | 读取并校验法域配置 | `regionId`, config root | 不可变 `RegionProfile` |
| `core/signals/score.mjs` | 五维归一化与三画像确定性打分 | `signals.json`, weights | 稳定序列化 `score.json` |
| `core/compliance/evaluate.mjs` | 根据规则数据判定准入与追溯 | profile、商品事实 | `compliance/report.json` |
| `core/pricing/calculate.mjs` | 基于冻结快照计算价格与差额归因 | 成本、重量、snapshot | price 或 `pricing_unavailable` |
| `core/content/build-master.mjs` | 汇总六类内容为平台无关母版 | 商品事实、内容通道结果 | `master/` |
| `core/package/assemble.mjs` | 写 run 状态、回执与完整交付目录 | master、投影、降级记录 | `package/<sku>/` |
| `adapters/platforms/project.mjs` | 只映射字段、拼装标题、派生图片 | master、platform spec | `platforms/<p>/` |
| `channels/*` | 探测、执行、故障分类 | 统一 channel input | 统一 channel result |

LLM 只可生成解释、风险描述与文案候选；分数、价格、合规状态、校验结论必须由确定性代码产生。

## 5. 数据与新鲜度

### 5.1 外部事实

规格和变量共用同一事实信封：

```json
{
  "key": "fx.USD_CNY",
  "value": 0,
  "unit": "CNY/USD",
  "scope": {"region": null, "platform": null, "category": null},
  "source": "source-id",
  "source_url": "https://...",
  "source_type": "official",
  "fetched_at": "1970-01-01T00:00:00.000Z",
  "ttl_hours": 24,
  "stale": false,
  "cross_check": [],
  "divergence_pct": null,
  "override": null
}
```

事实文件只允许两种包装：顶层数组 `[fact, ...]`，或对象 `{"facts": [fact, ...]}`。不得在任意嵌套对象里隐式藏事实；结构化平台规格（标题模板、格式列表）放在单条 fact 的 `value` 中，`unit` 写 `json/template/format-list` 等实际单位，`key` 使用稳定点路径。规格记录遵循 `spec-record.schema.json`，变量记录不强制 confidence/status。

`source_type` 描述数据来源，`confidence` 描述结论可信度；两个字段各有独立枚举，禁止把 source_type 的值写进 confidence 或反向赋值。规格记录另带 `status: candidate/final/conflicted/unverified`；secondary 只能是 candidate 或 conflicted，不得成为 final。user-override 只能人工修改。未核规格写 `status: unverified`、`value: null`，`source_url` 填官方查询入口。缺四元组任一项即阻断该事实进入计算。

### 5.2 在线 doctor

`npm run doctor` 默认联网执行：

1. 校验配置、环境变量与数据 schema。
2. 对 fresh 事实保留快照；对 stale 且可刷新事实调用对应 source channel。
3. 记录实际 `fetched_at`、来源 HTTP 状态和刷新结果。
4. 刷新失败时标 `stale + expired_days`；无可用值标 `missing`。
5. `cost / weight / fx` 任一 missing 时只禁止出价，不禁止出包。

测试中通过 fake clock 与故障 channel 模拟过期、超时、HTTP 错误和无数据，不要求真实断网。`assessFact(null, now)` 与缺失记录统一返回 `status: missing`、`expiredDays: null`，不拿旧值冒充可用值。

doctor 退出矩阵：配置/schema 不可读或运行环境硬故障为 exit 1；可运行降级（stale、missing、pricing_unavailable、compliance blockers、能力 unavailable）为 exit 0。demo 与 pack 复用同一个 `runDoctor()` 前置检查，不得仅执行 `npm run doctor || true`；它们还必须校验本次解析出的 sources、配置与快照哈希和 doctor 状态一致，防止并发改写。

FX 源配置含 `pair`、`role`、JSON Pointer mapping 与 `cost_direction`。同一 pair 的主源和 cross-check 必须计算 divergence_pct：超过 0.5% 取对成本不利的一侧、标 divergent 并写 `data/conflicts.json`；交叉源失败或超差未裁决时禁止出价但继续出包。新增同形 JSON 汇率源只改 `data/sources.json`，由 `http-json` channel 按 mapping 取数；只有响应结构不同的新协议才新增 adapter。

### 5.3 快照与复现

每次 run 冻结 `variables.snapshot.json`，产物记录 `snapshot_id` 与 SHA-256。同 SKU、同 snapshot 的价格输出逐字节一致；换 snapshot 时，各项归因之和与总差额误差不超过 0.01。快照不入 git。

## 6. 通道契约

```js
export const meta = {
  name: "mock",
  kind: "imagegen",
  requires: "none",
  capabilities: {},
  cost: {"currency": "CNY", "unit_price": 0}
};

export async function probe() {
  return {ok: true, detail: "ready"};
}

export async function run(input) {
  return {ok: true, files: [], meta: {}, usage: {}};
}

export function fault(error) {
  return "unknown";
}
```

`fault()` 只允许返回 `billing / moderation / rate / transient / unknown`。billing 立即停；moderation 换输入；rate 与 transient 才可按有限策略重试。

- `imagegen/mock`：生成真实 PNG 占位图，只验证流程；`validate.json` 写 `quality: "placeholder"`，handoff 顶部写不可直接投放。
- `imagegen/http-openai-compat`：先实现只读能力声明和 probe；能力未声明即视为不支持。真实 1 张最低档生图是独立 opt-in L2 动作，只有用户显式提供 key、确认单价与张数后才可执行；未执行时 OpenAI 真生成完成度固定为“未验证”，不得被本地 probe 代替。
- `storage/lab`：默认本地目录，不配置公共图床。
- `source/http-json`：按 `data/sources.json` 取数，响应适配器只负责转成事实信封。

## 7. 选品、合规与内容

### 7.1 选品

纯函数输入手写或在线采集的 `signals.json`，输出同批候选在三套画像下的排名变化。每条 signal 遵循 `signal.schema.json`，带 `fetched_at / data_as_of / reporting_lag / is_realtime`；T+1 必须 `is_realtime: false`，未知数据时点写 null + unverified，不得仅凭抓取时间宣称实时。权重均为正数，构造向量时使用 `100 - C`。同输入两次输出逐字节一致，因此 score 不写运行时间戳。每维都能点回原始信号 URL；`signal_coverage` 用 low/medium/high 表示覆盖度，`confidence` 仍只用 official/secondary/unverified 表示来源结论可信度。无账号时使用公开来源并标低覆盖度，不停机。

### 7.2 合规

规则数据与计算逻辑分离。首条链路只实现 RU 女装外套的准入层和追溯层；S 级规则必须带 `confidence: "secondary"` 与官方核查入口。合规模块不写关税、VAT、认证费用或清关时效数值。blockers 非空仍出包，`handoff.md` 第一行写 `BLOCKED: <原因>`；若同时使用 mock 图，第二行紧跟占位图不可投放声明。无 blockers 时，占位声明占第一行。

### 7.3 母版与投影

母版为 3:4、900×1200 起步、固定 9 张；1:1 只能由母版上下各裁 12.5% 派生，`crop.json` 用 `{"crops":[...]}` 逐图记录 src/src_sha256/output/box/algo_version。主体必须位于中间 75% 高度带，不安全图标 `crop_unsafe`。Ozon/WB 不补满 30 张，禁止复制凑数；打包前用感知哈希检查重复。

标题保存六段 tokens，平台模板只读 `data/specs/platforms/<p>.json`。平台投影不得改写 master 文案，字段缺失写 `unavailable + reason`，不得留空或编造。

## 8. 验收门

| 门 | 本轮判据 | 级别 |
|---|---|---|
| G1 | decouple 门空仓库通过；注入平台名或删 source_url 后变红；输出扫描计数，fixture 测试断言 fact/profile/platform 数大于 0 | L0/L1 |
| G2 | core 与 adapters 无裸网络访问 | L0 |
| G3 | add-region 不改 core，并生成可校验空壳 | L1 |
| G4 | 加汇率源只改 sources.json | L1 |
| G5 | 模拟来源失败后，stale/missing 与过期天数完整可见 | L1 |
| G6 | **零 key + 联网**跑 demo 出完整包，mock 图为真 PNG | L1 |
| G7 | 同一 OpenAI 兼容协议内换 provider 只改配置；不同协议新增 channel，业务代码零改动 | L1 |
| G8 | 同 signals 两次 score 逐字节一致 | L1 |
| G9 | 同 snapshot 价格一致；换 snapshot 归因闭合 | L1 |
| G10 | 只装 Node，联网执行四条命令出包 | L1 |
| G11 | 无 image key、无浏览器时模板合成独立产图 | L1 |
| G12 | 三平台投影文案零改写，1:1 可追溯 | L1 |
| G13 | 内容寻址幂等，改一像素文件名改变 | L1 |
| G14 | 新用户照 handoff 人工投一次 | L2，未做不得称可直接贴 |

四条命令唯一为 `npm ci`、`npm run doctor`、`npm run demo`、`npm run pack -- <sku>`。doctor 只有硬故障（配置/schema 不可读、必需运行环境无效）才 exit 1，此时 demo 与 pack 拒绝启动；数据过期、来源失败、成本/重量/汇率 missing 或合规 blockers 属于可运行降级，doctor exit 0 并输出 `pricing_unavailable` 等状态，包照出但价格省略。所有降级必须进入回执。

## 9. 施工与唯一写者

| 工作流 | 唯一写者 | 可写目录 |
|---|---|---|
| 总架构与集成 | 主 agent | `docs/`、`schemas/`、`cli/`、根配置、集成测试 |
| P6 解耦门 | gate agent | `scripts/gates/`、`tests/gates/` |
| P1 数据治理 | data agent | `core/data/`、`channels/source/`、`data/`、`tests/data/` |
| P2 能力通道 | channel agent | `channels/imagegen/`、`channels/storage/`、`tests/channels/` |
| P3 信号与打分 | signal agent | `core/signals/`、`tests/signals/` |
| P4 合规 | compliance agent | `core/compliance/`、`regions/*/compliance/`、`tests/compliance/` |
| P5 内容与投影 | content agent | `core/content/`、`core/package/`、`adapters/`、`tests/content/` |

任何跨目录接口变化先由主 agent 改契约，再通知实现者；禁止两个 agent 同时修改根 `package.json`、README 或共享 schema。

## 10. 两轮自迭代

1. **规格自审**：逐条映射 I1-I7、P0-P6、G1-G14；检查占位、冲突、未定义接口、无判据要求，修完再进入集成。
2. **对抗验收**：门注入坏样本必须变红；模拟来源失败必须露出 stale/missing；零 key + 联网跑 demo；检查包结构、placeholder 声明、投影 diff 与真实命令输出。

## 11. 主要坍塌风险

1. **外部事实被当成静态常量**：九法域与不同 TTL 会使硬编码迅速失真，因此先建事实信封、来源配置和快照。
2. **共享 schema 漂移**：多模块并行时最容易各自发明字段，因此 schemas 只由主 agent 修改，所有模块先跑契约测试。
3. **投影反向污染母版**：平台字段或文案一旦进入 master，后续平台扩展会改坏旧产物，因此用零改写 diff 与 crop 追溯门机械拦截。

九法域意味着规则组合不可穷举成分支，会过期的数字意味着构建时常量不能代表运行时事实；所以地区、来源、TTL、平台模板和冲突处置都必须是数据，核心只处理稳定算法。
