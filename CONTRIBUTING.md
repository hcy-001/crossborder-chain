# 贡献指南

最有价值的贡献是**给一个平台补事实**。其次是加一个法域。代码改动排在第三——因为这个仓库的价值在事实层，不在代码量。

## 铁律（会被机械门拦下）

1. **`core/` 里不得出现平台名字面量。** 业务规则属于 `data/specs/platforms/<p>.json`，不属于代码。`npm run check:decouple` 会扫。
2. **每条事实必须带 `source_url`、`fetched_at`、`status`。** 没有来源的数字不许进仓库。
3. **改了数据结构，同一次改动里同步 `schemas/`。** 否则 `additionalProperties: false` 会让整包静默生成失败。
4. **测试断言不要绑在「某个平台当前恰好缺某条事实」上。** 事实补齐后测试会自己失效。要测机制，就主动构造缺失场景。
5. **官方原文与二手转述分开标。** `final` = 官方原文；`candidate` = 二手或多源未核；`unverified` = 没查到。查不到就不写数字。

## 怎么给一个平台补事实

以「某平台标题上限」为例：

```bash
# 1) 先确认这个平台的文档通道能不能用
npm run platform:readiness

# 2) 拿到原文，落盘留证（不要只在对话里看过）
#    存到 out/verification/official-docs/<platform>/

# 3) 写进事实文件
#    data/specs/platforms/<platform>.json 的 facts 数组
```

一条事实长这样：

```json
{
  "key": "platform.example.title.max_chars",
  "value": 60,
  "unit": "chars",
  "scope": {"region": "RU", "platform": "example", "category": "fashion"},
  "source": "example-seller-instructions",
  "source_url": "https://…",
  "source_type": "official",
  "confidence": "official",
  "status": "final",
  "conflict_id": null,
  "fetched_at": "2026-11-02T00:00:00.000Z",
  "ttl_hours": 4320,
  "stale": false,
  "cross_check": [],
  "divergence_pct": null,
  "override": null,
  "note": "官方原文摘录 + 为什么取这个值（若文档内部有出入，写清两处数字与取舍理由）"
}
```

`note` 不是注释，是**给下一个人判断能不能用这条事实的依据**。文档内部自相矛盾时（这很常见），把两处数字都写进去并说明取严的理由，不要只留一个数。

## 怎么让平台可出包

投影至少需要两样东西：**图片比例**（或 `ratio_policy: preserve`）与**标题规则**。

- 平台规定比例 → 写 `platform.<p>.image.ratio`，1:1 会走「等比缩放 + 白底补方」
- 平台不规定比例（只给像素范围）→ 写 `platform.<p>.image.ratio_policy = "preserve"`，原图直出
- 两个都没有 → 投影会抛 `FACTS_INCOMPLETE`，这是**正确行为**，不要用默认值绕过

## 本地验证

```bash
npm test               # 361 项，零网络零 key
npm run check:decouple # 七道机械门
npm run evals          # 产出正确性
npm run quickstart     # 端到端冒烟
```

四条都过再提交。CI 会跑同样四条。

## 提交信息

用祈使句，说清改了什么、为什么：

```
补 Wildberries 中文文档事实：标题 60 字符、图片 700×933

- 来源：seller.wildberries.ru/instructions/cn/ch/material/A-292（官方中文，更新日期 2026-11-08）
- 700:933 正好是 3:4，母版可原图直出，不需要补边
- 文档内部有 700×933 与 700×900 两处，取严用 933，矛盾已记进 note
```

## 许可

提交即表示同意以 MIT 许可发布你的贡献。
