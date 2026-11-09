# NOTICE — assets/tool-bootstrap.mjs

`tool-bootstrap.mjs` 来自 <https://github.com/xiaobright/dsh-anchored-standard>（MIT），
并包含 dsh-liangshen 的两阶段隔离扩展。原始 DeepSeek Harness 内置 Minimal / Standard
preset 的版权与 MIT 许可声明见该上游仓库。

本仓库为交易侧 vendored 使用。**含一处本地适配**（2026-11-09）：宿主 0.2.2 起
`system-prompt/assemble` 的装配体不再带工具面（服务在瀑布之后自行追加 `tools`），
所以组装期改读注册面 `agent.ctx.tools.definitions(agent)`，并停止返回被丢弃的
`tools` 裁剪结果。上游更新时按「重新复制 + 重新施加该适配 + 重跑测试」方式升级，
用例见 `packages/base/test/tool-bootstrap-assemble.test.ts`。

用法边界：本插件只做「首轮工具面收窄 + 稳定后晋升」，不改变任何交易的审批闸门；
phase 1 暴露的工具仍走同一 `ctx.tools` 注册面与同一执行管线。宿主 0.2.2 上首轮的
工具收窄已不可达（admission 早于组装），首轮保持全量目录，消息隔离与 token 上限照旧。
