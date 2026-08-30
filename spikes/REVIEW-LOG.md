# Spike 评审日志（主 agent）

## S1 树外 bundle 安装 — ✅ PASS（2026-08-29 15:10 复核）
- 证据复核：artifacts/12（boot marker）、15（双 bundle 分层 dump）、18（双 ACTIVATED）均与报告一致；分层序 bundle→profile→home→overlay 与 patch 整行替换语义符合 ground truth。
- 重要发现：裸路径 add=link: 语义不装传递依赖，本地分发必须 file: 前缀；file: 是硬链接（改源码需重装）；home 级 patch 悬空行会炸所有 profile（建议上游降级为警告）。
- 裁决：机制成立，市场 bundle 体系可按 insert-only 铁律直接承载。

## S4 服务 API 调研 — ✅ PASS（2026-08-29 15:1x 复核）
- 抽核 4 处全部命中：base patch 含 credentials-local:98 / subprocess-local:206 / user-approval:231；PreToolDecision.ask 语义注释一致；schedule MIN_EVERY=300s。
- 关键裁决：
  - schedule 不适合交易定时（无 cron、≥5min、session-local）→ 自动化另案（插件自管 timer / webhook / cron+headless）
  - **headless 下 ask=deny**（无应答者 fail-closed）→ 铁律 3 修订：实盘闸门 = 显式开关为主、approval 仅交互形态
  - python 桥 = ctx.subprocess（显式 argv、环境清洗、进程树管理）；python/ 目录是反向件（Python 驱动 DSH）
  - credentials refs+records 分工明确，BYOK 落地路径清晰
## S2 skill 随包分发 — ✅ PASS（2026-08-29 复核）
- 证据链完整：组合树 dump（行落树）→ headless 加载断言（SKILL_MARKER×5 + RESOURCE_NOTE）→ 会话持久化直证（zstd 解压 session.jsonl，skill-catalog 31 条含 spike 条目、tool/call 记录）→ 卸载后负向断言（30 条无 spike、SKILL_ABSENT_IN_CATALOG）。
- 抽核命中：BUNDLED_SKILL_RANK=600（skill/src/index.ts:27）；base patch skill:279 / skill-badge disabled:287 / tool-skill:289。
- 采纳建议：skill 名市场前缀命名空间；provider 插件 inject=['skills']；候选 rank=600（用户目录 100-500 天然覆盖，写进文档）；远程目录用 Observation+invalidate。
- 新事实：第三方包把包名直接写进 profile bundles 即可（带 dsh.bundle.patch），无需用户 patch 层。

## S5 包规范+脚手架 — ✅ PASS（2026-08-29 复核）
- 抽核命中：plugin.ts reconcile 逻辑（59-91）与报告一致；npm 只有 0.0.1-rc.1（我此前独立验证过 exa/headless）。
- 对计划的修订：
  1. 官方不用 changesets（自制单版本家族 bump）→ 我们可用 changesets fixed 组实现同语义，或简化为脚本；待定稿
  2. 构建改单步 tsdown dts:true（官方两段式是为 100+ 包互指源码设计的，我们用不上）
  3. 插件包=SDK peer / bundle=实装依赖 二分采纳
  4. profile pnpm-workspace.yaml 是 dsh 维护的 append-only——CI/脚本不得重写它
  5. 本地联调统一 file: 绝对路径（S1 硬链接坑）或 tarball
- TEMPLATES.md 已产出，脚手架阶段直接采用。
## S3 preset root+自安装 — ✅ PASS（2026-08-29 复核）
- 抽核命中：agent-presets 行确实在 web-app bundle（:435）而非 base——headless 宿主须先 insert 该行（项目关键事实）；discovery 无记忆化（index.ts:151），自安装免重启 2 秒级感知（roster-live.jsonl 实测序列）。
- 采纳建议：preset root 用市场自有目录（~/.dsh-trading-presets），**不**混入 ~/.dsh/.agent-presets；preset 引用的插件必须进市场 bundle 的 dependencies（否则标 broken）；改 agent.cordis.yml 即新代际免重启生效。
- 坑入账：file: 依赖是安装时快照（改码须重装）；agents.create setup 必须返回 undefined；patch 打不存在的行仅警告（静默落空风险）。

---

# 第 0 阶段总结论：S1-S5 全部 PASS，无降级项，进入第 1 阶段（脚手架）

## S6 指标服务通道 + 社区指标接入 — ✅ PASS（2026-08-30 主 agent 实证）
- 实证形态：`@dsh-trading/indicator-supertrend`（社区指标示例，ATR 本地实现零运行时依赖 core）经 **profile 级 cordis.patch.yml insert 行**挂载，client 半 `ctx.inject(['tradingIndicators'])` 拿服务 `register(definition)`。
- 真实 Chrome 实测（trading-web 3081）：选择器名册 = 六预置 + 超级趋势同榜；勾选后 ST 读数出值（72310.90 @ BTC）；与预置 MACD/MA 共存；勾选态跨重启+刷新持久。
- 卸载语义：删 profile patch 行 + 重启 → 超级趋势下榜（provide 随 fiber 注销）；恢复行 + 重启 → 重新上榜。**无 live 卸载**：patchReload live 不重载已挂 fiber，页面刷新是消费方本地注册表的清理边界（definition 按值合并，留存至刷新）。
- 两个宿主级事实（修复过程中落定）：
  1. **client 半加载 = Loader 条目，不是 node_modules 闭包**——传递依赖包必须由某个 bundle 的 cordis.patch.yml insert 行挂载（client-ui-indicators 曾因此「已安装未加载」，指标选择器空态）；dsh-client-modules 扫 Loader entries 组 `__DSH_BOOT__`。
  2. patch 行严格解析：行内包名不存在 → boot 崩溃（ERR_MODULE_NOT_FOUND），不是警告。
- 采纳：spike 包保留为 `packages/indicator-supertrend`（社区指标接入示例）；接入套路沉淀在 Agent Note「指标系统插件化」。
