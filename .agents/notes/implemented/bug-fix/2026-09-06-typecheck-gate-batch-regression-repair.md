# typecheck 棘轮门禁批量回归修复（发版前清障）

- **日期**: 2026-09-06
- **状态**: implemented

## 现象

v0.1.3 发版后的 025d566..5f37006 批量推送（f8f794e research context + 1d3e220
HomeHistory 工作区删除入口）使 scripts/typecheck-gate.mjs 从 504 涨到 513
（base +5、client-ui-trading +8），ci.yml 自该批次起持续红，main 不满足发版
前提「本地 main 全绿」。

## 归因（worktree 隔离复现）

- 5f37006（origin/main）干净 worktree 复现同值 513 —— 与本地两个未推送 fix
  （0329299 面板层级、fd011a9 desktop symbol 归一）无关。
- 与 025d566（最后绿点）按 file+code+message 做误差集合差：新增恰 13 条，
  无一条误伤旧债。

## 修复（最小补丁，不抬基线）

1. base/src/research-tools.ts：Config.markets 收紧为市场字面量联合（TS2375）；
   symbolParam.required 加 as const（TS2322 ×2）。
2. base/src/role-skills.ts：SkillCandidate.locator 在 SDK 里是 unknown、
   resourceBase 可选，get() 返回值不再是 SkillDefinition —— 引入
   RoleCandidate = SkillCandidate & { resourceBase; locator: URL } 具体化。
3. client-ui-trading/src/client/contract.ts：MarketLocaleKey 补登记
   browser.ws.{aria,delete,delete.desc,delete.pending,cancel} 五键 ——
   1d3e220 只写了词典（zh/en）没登记联合，属真实缺陷：删除确认菜单运行时
   会显示裸键名。

## 结果

全家族总错误 500 ≤ 基线 504（base 归零，client-ui-trading 55 持平），棘轮
通过且未上调基线。发版 v0.1.4 的 changeset 挂在 client-ui-trading，同批随
版本发布。
