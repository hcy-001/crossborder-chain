# 链路实测证据 persona-check-02

- 状态：complete · 用时 14.2s · 品类 女装 / 法域 RU
- 判别：6 次（llm=6），合计 7175 token
- 降级：llm: mock-llm；imagegen: mock
- 证据等级：判别 L1（判别桩/通道降级，非模型判断） ｜ 出图 L1（占位图）
- 人群：selfgrade-probe-9db535=A(unpriced)；探索配额 0/2

| 判别点 | 来源 | 采用 | 置信 | 耗时 | token | 解析层 |
|---|---|---|---|---|---|---|
| copy_pitch | llm | 是 | medium | - | 1114 | strict |
| information_audit | llm | 是 | medium | - | 934 | strict |
| market_profile | llm | 是 | medium | - | 884 | strict |
| persona_assign | llm | 是 | medium | - | 1956 | strict |
| platform_mapping | llm | 是 | low | - | 959 | strict |
| shoot_plan | llm | 是 | medium | - | 1328 | strict |

出图 9 张，全部 900×1200，两两可区分；建模 selfgrade-probe-9db535=planned

展陈渲染边界（口径固定，不随运行变化）：几何复用建模技能的 zoomcare-pillbox 展位预设，招牌与材质观感由该技能 scene.html 固定；商品本体不在场景内；design.json 里的材质色是否被渲染场景消费未做像素级验证（两次真渲对比几乎逐像素相同）。
