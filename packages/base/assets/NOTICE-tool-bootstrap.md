# NOTICE — assets/tool-bootstrap.mjs

`tool-bootstrap.mjs` 来自 <https://github.com/xiaobright/dsh-anchored-standard>（MIT），
并包含 dsh-liangshen 的两阶段隔离扩展。原始 DeepSeek Harness 内置 Minimal / Standard
preset 的版权与 MIT 许可声明见该上游仓库。

本仓库为交易侧 vendored 使用，改动仅限挂载配置（见 `packages/base/src/presets.ts`
的 `bootstrapRow`），未修改插件源码。上游更新时按「重新复制 + 重跑测试」方式升级。

用法边界：本插件只做「首轮工具面收窄 + 稳定后晋升」，不改变任何交易的审批闸门；
phase 1 暴露的工具仍走同一 `ctx.tools` 注册面与同一执行管线。
