# 链路实测证据 real-l2-03

- 状态：complete · 用时 619.0s · 品类 女装 / 法域 RU
- 判别：6 次（llm=6），合计 12515 token
- 降级：无
- 证据等级：判别 L2（全部判别点由真实模型返回，台账可回放） ｜ 出图 L2（9 张真实模型出图）

| 判别点 | 来源 | 采用 | 置信 | 耗时 | token | 解析层 |
|---|---|---|---|---|---|---|
| copy_pitch | llm | 是 | high | 66.2s | 2692 | strict |
| information_audit | llm | 是 | high | 13.6s | 1139 | strict |
| market_profile | llm | 是 | medium | 13.3s | 1184 | strict |
| platform_mapping | llm | 是 | low | 33.6s | 1598 | strict |
| ref_roles | llm | 是 | high | 60.8s | 3454 | strict |
| shoot_plan | llm | 是 | low | 42.5s | 2448 | strict |

出图 9 张，全部 900×1200，两两可区分；建模 kardigan-udlinennyi-zhensk-01cfdb=rendered（6 个文件）

展陈渲染边界（口径固定，不随运行变化）：几何复用建模技能的 zoomcare-pillbox 展位预设，招牌与材质观感由该技能 scene.html 固定；商品本体不在场景内；design.json 里的材质色是否被渲染场景消费未做像素级验证（两次真渲对比几乎逐像素相同）。
