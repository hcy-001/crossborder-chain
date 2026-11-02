# 链路实测证据 check-llm-02

- 状态：complete · 用时 274.9s · 品类 女装 / 法域 RU
- 判别：6 次（llm=6），合计 11012 token
- 降级：imagegen: mock
- 证据等级：判别 L2（全部判别点由真实模型返回，台账可回放） ｜ 出图 L1（占位图）

| 判别点 | 来源 | 采用 | 置信 | 耗时 | token | 解析层 |
|---|---|---|---|---|---|---|
| copy_pitch | llm | 是 | medium | 68.3s | 2680 | strict |
| information_audit | llm | 是 | high | 15.4s | 1185 | strict |
| market_profile | llm | 是 | medium | 18.5s | 1214 | strict |
| platform_mapping | llm | 是 | low | 20.7s | 1515 | strict |
| ref_roles | llm | 是 | high | 17.3s | 2253 | strict |
| shoot_plan | llm | 是 | low | 34.3s | 2165 | strict |

出图 9 张，全部 900×1200，两两可区分；建模 kardigan-udlinennyi-zhensk-01cfdb=planned
