---
"@dshtrading/holdings": minor
---

统一资产台账 agent 工具面补全：新增 holdings_confirm / holdings_discard /
holdings_add / holdings_update / holdings_remove（holdings_stage 收敛为截图导入的
默认路径，不再是权限边界）。台账为本地记账数据，全部工具仍不经审批闸门、不触发
任何买卖；跨区 id 返回指向正确工具的提示，写成功统一 emit tradingEvents('holdings')。
