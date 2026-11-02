# 链路实测证据 real-l2-01

- 状态：complete · 用时 715.7s · 品类 女装 / 法域 RU
- 判别：6 次（llm=6），合计 12261 token
- 降级：无
- 证据等级：判别 L2（全部判别点由真实模型返回，台账可回放） ｜ 出图 L2（9 张真实模型出图）

| 判别点 | 来源 | 采用 | 置信 | 耗时 | token | 解析层 |
|---|---|---|---|---|---|---|
| copy_pitch | llm | 是 | high | 86.5s | 3220 | strict |
| information_audit | llm | 是 | high | 16.9s | 1335 | strict |
| market_profile | llm | 是 | medium | 18.5s | 1090 | strict |
| platform_mapping | llm | 是 | low | 17.7s | 1525 | strict |
| ref_roles | llm | 是 | high | 26.8s | 2545 | strict |
| shoot_plan | llm | 是 | low | 53.6s | 2546 | strict |

出图 9 张，全部 900×1200，两两可区分；建模 kardigan-udlinennyi-zhensk-01cfdb=rendered（6 个文件）
