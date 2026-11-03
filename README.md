# crossborder-chain

跨境电商上品材料包生成器。输入品类、目标法域、候选数量，输出一份可以交给运营直接提交的材料：母版图、各平台图片、标题、文案、尺码映射、合规清单、交接说明。

不调用平台 API，不保存商户凭证，不自动提交。

8 个平台：Ozon、Яндекс Маркет、Wildberries、Shopee、Lazada、TikTok Shop、Amazon、noon。
9 个法域：RU、SG、MY、TH、PH、ID、VN、AE、SA。

[![CI](https://github.com/hcy-001/crossborder-chain/actions/workflows/ci.yml/badge.svg)](https://github.com/hcy-001/crossborder-chain/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

## 安装

需要 Node.js 20 或以上。

### 拖进技能目录

1. 从 [Releases](https://github.com/hcy-001/crossborder-chain/releases) 下载 `crossborder-chain-v1.2.2.zip`
2. 解压，得到 `crossborder-chain/` 文件夹
3. 整个文件夹放进技能目录：
   - WorkBuddy：`~/.workbuddy/skills/`
   - Claude Code：`~/.claude/skills/`
4. 重开一个会话

文件夹名必须是 `crossborder-chain`，与 `SKILL.md` 里的 `name` 一致。改成别的名字不会被加载。

用 Code → Download ZIP 也可以，但解出来叫 `crossborder-chain-main/`，要改回 `crossborder-chain`。

### git clone

```bash
git clone https://github.com/hcy-001/crossborder-chain.git ~/.workbuddy/skills/crossborder-chain
```

### 当命令行工具用

```bash
node scripts/run-direction.mjs --direction "女士针织开衫" --region RU --intake data/intake/demo-ru.json
```

可选自检：

```bash
node install.mjs          # 检查 Node 版本、安装依赖、跑三项冒烟
node install.mjs --check  # 只检查，不安装
```

依赖只有出包会用到（`ajv` + `sharp`），首次运行时自动安装，约 5 到 10 秒。①②③段、问卷、1688 报价只用 Node 标准库，装不上依赖也能跑。

## 第一次跑

```bash
npm run quickstart
```

不需要 key，不需要联网，约 10 秒。跑完会打印 `handoff.md` 的位置。

样例故意留了 4 项阻断（没填问卷、没有品牌授权、没有认证），用来看清缺材料时工具怎么报。

跑完整链路：

```bash
npm run chain:dir -- --direction "女士针织开衫" --region RU --intake data/intake/demo-ru.json
```

干净 clone 首次约 36 秒。本机已有历史产物时会重新出图，约 4 到 5 分钟。产出在 `package/<sku>__<时间片>/`。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run quickstart` | 零 key 跑通全链路，产出演示包 |
| `npm run chain:dir -- --direction "..." --region RU` | 方向 → 出包，并列出上架还缺什么 |
| `npm run chain -- --category 女装 --region RU --candidates 2` | 已有工单和答卷时直接出包 |
| `npm run market:scan -- --direction "..." --region RU` | 方向验证：品类码、进口规模、季节窗口、价格带 |
| `npm run select:candidates -- --direction "..." --region RU --count 8` | 出 5 到 10 个候选，带依据与自我查证 |
| `npm run source:lookup -- --direction "..." --region RU --pick c01` | 反查货源：检索词、规格、目标进价上限 |
| `npm run quotes:1688 -- --keyword "针织开衫" --target-price 71.6` | 抓 1688 真实报价，需 922 端口上已登录的 Chrome |
| `npm run intake -- --list --how` | 29 项上架问卷，每项写清从哪拿 |
| `npm run title:check -- --platform noon --text "..."` | 按平台规则检查标题 |
| `npm run platform:readiness` | 重新生成 8 平台 × 9 法域就绪矩阵 |
| `npm run probe:account -- --platform ozon --env <路径>` | 探测账号能读什么、能不能写 |
| `npm run mcp` | 以 MCP server（stdio）暴露给其他客户端 |

退出码：`0` 完成（含降级），`2` 输入或前置不成立，`3` 有候选失败，`4` 机械门未过。

## 产出

```text
package/<sku>__<时间片>/
├── handoff.md          # 交给人的说明：阻断项置顶、市场底数、开工三步、文件地图
├── onepager.html       # 一页商品卡，数据全部来自包内
├── receipt.json        # 机器回执：每段决定与依据
├── master/             # 母版：9 图、标题 tokens、文案源、每图 sha256
└── platforms/<平台>/
    ├── images/         # 按该平台规格产出
    ├── crop.json       # 几何变换台账
    ├── size-mapping.json
    ├── title.txt       # 过 lint 才写
    ├── copy/           # 逐条可粘贴的文案
    └── validate.json   # 通过项、违规项、未核事实
```

`handoff.md` 第一屏是阻断项，每条带解法：

```text
BLOCKED: 本包暂不可直接上架（4 项待解）
  1. 待完成：准入完成后，须由目的国进口商申请一物一码 DataMatrix……
     怎么解：找代运营或服务商办诚信标签（Честный знак），办完再上这一批
  2. 待完成：EAC 证书主体、诚信标签申请主体与进口报关主体必须一致。
  3. 品牌授权未证（brand_unknown）：不得上架品牌款
  4. 上架信息未收齐（--intake 缺失）：价格未出，不得声称可上架
```

## 平台与法域

| 平台 | 法域 | 备注 |
|---|---|---|
| Ozon | RU | 尺寸字段为顶层 `width/depth/height`，VAT 0% |
| Яндекс Маркет | RU | 平台不规定图片比例，原图直出 |
| Wildberries | RU | 尺码为独立 `sizes[]` 数组，一卡多码 |
| Shopee | SG MY TH PH ID VN | 1:1，等比缩放补白边，不裁切 |
| Lazada | SG MY TH PH ID VN | 1:1 为多源口径，补边不裁；尺寸下限待后台确认 |
| TikTok Shop | SG MY TH PH ID VN | 1:1，补边 |
| Amazon | AE SA SG | 官方不规定比例，原图直出 |
| noon | AE SA | 26 条 final 事实 |

九个法域都至少有一个可出包平台。实时状态用 `npm run platform:readiness` 生成，不要手改这张表。

## 事实等级

每条平台规则带 `source_url`、抓取时间、等级：

- `final`：官方原文，可以当依据
- `candidate`：二手或多源未核，需要人工确认
- `unverified`：没核实
- `unavailable`：缺数据，写清缺哪项

缺关键事实（例如图片比例）时抛 `FACTS_INCOMPLETE`，不拿行业惯例顶替。1:1 平台做等比缩放加白底补边，不裁母版；平台不规定比例时原图直出。

## 边界

- 不打分：候选排序用确定性规则，同输入两次结果一致
- 不出价：运费、税费、佣金缺任一项，价格标 `unavailable`
- 不翻译：拿不到目标语就留空，不写空字符串
- 不提交：不调上架 API，不存凭证

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 技能列表里没有它 | 目录名不是 `crossborder-chain`，或没重开会话 | 改名，重开会话 |
| 出包时报缺 `sharp` / `ajv` | 自动安装没跑成（离线或代理） | 在 skill 目录跑 `npm ci --registry=https://registry.npmmirror.com` |
| `npm ci` 超时 | 到 npm 官方源不通 | 同上换镜像 |
| `Node 版本过低` | 需要 Node 20 以上 | 装 LTS |
| 报价抓到无关商品 | 1688 搜索表单是 GBK 编码 | 确认走 `channels/source/ali1688.mjs` 的 `buildSearchUrl`，仓库测试会拦 UTF-8 拼法 |

## 文档

- [`docs/信息需求清单.md`](docs/信息需求清单.md) — 29 项问卷逐项写清从哪拿、谁去办、查不到怎么办
- [`docs/交接.md`](docs/交接.md) — 接手者先读：三条命令、代码地图、哪里不能动
- [`docs/平台就绪矩阵.md`](docs/平台就绪矩阵.md) — 8 平台 × 9 法域，谁缺什么
- [`docs/信息源盘点.md`](docs/信息源盘点.md) — 七类通道的实测可用率
- [`docs/未决问题清账.md`](docs/未决问题清账.md) — 每个攻不下的目标试过什么、为什么不通

## License

MIT，见 [LICENSE](LICENSE)。
