# SMOKE REPORT — dsh-trading crypto 切片骨架端到端冒烟

- 日期：2026-08-29（时间盒内完成）
- 执行：headless 执行子 agent（glm-5.3-flash）
- 环境：dsh 0.1.2-alpha.1（~/.local/bin/dsh）；scratch profile `trading-dev`（本轮新建）；dsh-trading @ /Users/zcl/code/dsh-trading（5 包，lib 已构建，未改任何包源码）

## 结论：**PASS**（5/5 验收点有证据；2 条非阻塞发现）

## 安装路径（全部 exit 0，日志见 logs/）

1. `dsh plugin --profile trading-dev add 'link:…/packages/web/web-search-exa'` → logs/01（home patch exa 行可解析，启动不崩）
2. `add 'link:…/packages/bundle/headless'` → logs/01；bundles = [dsh-base, dsh-headless]
3. profile `pnpm-workspace.yaml` 末尾 append `overrides:`，把 @dsh-trading/{api,base,connector-binance,kit-crypto,crypto} 钉到 `file:/Users/zcl/code/dsh-trading/packages/<名>`（append-only 追加，未动 dsh 维护的其余内容）
4. `dsh plugin --profile trading-dev add @dsh-trading/base @dsh-trading/crypto` → logs/02：**Packages: +5**（overrides 连带解析 workspace:* 传递依赖 api/connector-binance/kit-crypto，一次成功，未触发降级路径）

## 验收点逐条证据

| # | 验收点 | 证据 |
|---|---|---|
| 1 | 组合树分层 + trading 两行 + 不覆盖 base/官方行 | logs/03（dump 全文）：`# == @dsh-trading/crypto` 层插入 2 行 `dsh-trading-crypto-connector-binance` / `dsh-trading-crypto-kit`；logs/07（卸载前后 dump diff）：**唯一差异 = crypto 层那 8 行 insert，官方/base 层零改动** → insert-only 铁律实证 |
| 2 | profile 启动 exit 0 + 插件加载证据 | logs/03 exit=0；logs/04 headless 会话 exit=0，`crypto_get_ticker` 出现在模型函数表（= connector/kit 两插件均实际加载并注册成功） |
| 3 | 模型可见工具与 skill | logs/04：模型列出工具含 `crypto_get_ticker` 并实际调用，返回原样 `Error: crypto_get_ticker: not implemented (scaffold stub)`（占位实现 = 注册成功直证）；skill 目录含 `crypto-risk-checklist`，模型给出与 assets 描述一致的摘要 |
| 4 | crypto_get_ticker config 默认值入树 | logs/03 L358-362：connector 行 config `dryRun: true` / `liveTrading: false`（该工具所在插件行） |
| 5 | 卸载后无 trading 行 | logs/05（remove @dsh-trading/crypto，exit 0）→ logs/06：全 dump 0 条 `dsh-trading` 行；node_modules/@dsh-trading 仅剩 api+base（传递依赖被 pnpm 正确剪枝） |

## 发现的问题（供主 agent 处理，未改任何源码）

1. **`# == @dsh-trading/base` 层标记不会出现在 dump**：base 包 patch 为 `- insert: []`（脚手架 no-op，见 base/cordis.patch.yml 注释），dump 只渲染有产出的层。非安装缺陷——base 已在 bundles 列表且随会话正常加载；但验收点 1 原文的「两层标记」预期要等 base 后续切片真正 insert 共享行才会成立。「未被覆盖」改以 logs/07 全等 diff 作证。
2. **注释与实现命名不一致**：connector-binance/src/index.ts 注释写「trading-crypto-* 市场命名空间」，实际插件 id 为 `dsh-trading-crypto-connector-binance`（dsh- 前缀）。定名以哪个为准请主 agent 裁决（patch 行 id 与 Cordis name 同值，一致性重要）。
3. kit-crypto `installPreset` 为空占位（切片计划内，crypto-trader preset 本轮不可见，不判失败）。
4. ⚠️ 证据文件曾含 home patch 的 mem0 token（dump 会原样带出凭据），**已在 03/06 两份 log 中脱敏为 `m0-REDACTED`**；建议上游考虑 dump 对 credentials 脱敏。

## 证据索引

```
spikes/smoke/
├── PROMPT.md                          # headless 会话提示词
├── REPORT.md                          # 本报告
└── logs/
    ├── 01-profile-create.log          # profile 新建 + exa/headless link: 安装
    ├── 02-add-packages.log            # overrides 生效，Packages: +5
    ├── 03-dump-config-full.log        # 安装后组合树（token 已脱敏）
    ├── 04-headless-session.log        # 模型可见工具/调用/skill 全记录
    ├── 05-remove-crypto.log           # 卸载 crypto bundle
    ├── 06-dump-config-after-remove.log# 卸载后组合树（token 已脱敏）
    └── 07-diff-dump-before-after.log  # insert-only 证明（唯一差异 8 行）
```
