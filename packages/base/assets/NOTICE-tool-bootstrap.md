# NOTICE — assets/tool-bootstrap.mjs

`tool-bootstrap.mjs` 来自 <https://github.com/xiaobright/dsh-anchored-standard>（MIT），
并包含 dsh-liangshen 的两阶段隔离扩展。原始 DeepSeek Harness 内置 Minimal / Standard
preset 的版权与 MIT 许可声明见该上游仓库。

本仓库为交易侧 vendored 使用。**含两处本地适配**：

- 2026-11-09：宿主 0.2.2 起 `system-prompt/assemble` 的装配体不再带工具面（服务在瀑布之后
  自行追加 `tools`），所以组装期改读注册面判定组合，并停止返回被丢弃的 `tools` 裁剪结果。
- 2026-11-10：同一世代里 loop 先 `tools.resolve` 做本步工具准入、再组装提示词，所以首轮
  收窄改为**挂载期**的注册面限制——`agent/status` 首次 `running` 时对未晋升会话调用
  `agent.ctx.tools.restrict({ allow })`（一个 shell ＋ `commonTools`，compaction 之后并上
  `compactionTools`），晋升即释放；已在晋升态的续会话从持久事件复算后不收窄。组装期只剩
  段落/上下文窄化与组合漂移检查。挂载点与生命周期边界见插件头注，回归用例见
  `packages/base/test/tool-bootstrap-assemble.test.ts`。

上游更新时按「重新复制 + 重新施加这两处适配 + 重跑测试」方式升级。

用法边界：本插件只做「首轮工具面收窄 + 稳定后晋升」，不改变任何交易的审批闸门；
phase 1 暴露的工具仍走同一 `ctx.tools` 注册面与同一执行管线。宿主 0.2.2 实测：研究员与其
（委派）预设的首轮 `request/header` 都是 `bash` + `holdings_list` + `routing_get`，
模型发起工具调用触发晋升后，下一轮恢复全量 139 个工具。
