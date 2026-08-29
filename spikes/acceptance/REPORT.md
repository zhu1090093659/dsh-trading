# 任务 D REPORT — crypto 切片端到端验收（含结构性修复）

- 日期：2026-08-29 ｜ Profile：`trading-dev` ｜ dsh 0.1.2-alpha.1
- 结构性修复：自安装职责从 kit-crypto（preset 平面，鸡生蛋不可达）迁到 crypto bundle 的
  host 面常驻行 `dsh-trading-crypto-installer`；preset 资产随迁 `packages/crypto/assets/preset/`；
  agent-presets root 行仍归 base 层（未重复配置）。
- 验收手法：0 模型调用 —— 临时验收插件 `acc-plugin/`（**不进交付包**，plain 依赖 + `--patch`
  overlay 注入，overlay 同时 `disabled: headless-runner` 行杜绝模型调用）进程内读 roster、
  双 agent（join preset vs standard）对比工具/skill 可见性、直接调 `crypto_place_order` execute。

## 结论：6/6 PASS

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | profile 启动 exit 0；dump 含 base 两行 + 安装器行 | **PASS** | `logs/01-dump-config.log`（token 已脱敏）：`# == @dsh-trading/base` 层 `dsh-trading-base-gate`(:357) + `agent-presets`(:359，roots=`~/.dsh-trading-presets`，default=standard)；`# == @dsh-trading/crypto` 层 `dsh-trading-crypto-installer`(:369)。base 层标记出现（smoke 发现 1 已随 base insert 共享行解决） |
| 2 | crypto-trader 进 preset roster | **PASS** | `obs/roster-phase1.json`：`crypto-trader` broken=null、trust=user；boot 内 `presets.resolve()` 返回安装路径；安装文件与包资产逐字节一致（幂等安装直证） |
| 3 | 会话隔离（0 模型调用，进程内双 agent 对比） | **PASS** | `obs/isolation-phase1.json`：join crypto-trader 的 agent 可见 `crypto_get_ticker/crypto_get_klines/crypto_funding_rate/crypto_place_order` 全 true；未 join 的 standard agent 全 false；`presets.mount()` 成功无拒绝（**isolate realm 修复实测通过**，见下「验收中发现的修复」）；skill 目录 join 侧含 `crypto-risk-checklist`(34 条)、plain 侧不含(33 条) |
| 4 | 下单三段闸门集成面 | **PASS** | `obs/gate-phase1.json`（joined scope 内直接 `execute`）：`dryRun=true` → `{"status":"filled","dryRun":true,"note":"DRY-RUN — simulated fill…"}` 模拟回执；`dryRun=false` + `liveTrading=false` → `{"status":"rejected","code":"TRADING_LIVE_TRADING_DISABLED",…}` 结构化拒绝（闸门监听器 ask/deny 路径为 base 单测覆盖：28 测试绿） |
| 5 | skill crypto-risk-checklist 仍在目录 | **PASS** | `obs/isolation-phase1.json` `joinedHasRiskChecklist: true`（provider 随 preset 平面注册，须以 agent scope 视图 `list({scope})` 观察——host 视图看不到，符合 scope 分层） |
| 6 | 卸载 bundle → broken 而非崩溃；重装恢复 | **PASS** | `logs/02-remove-crypto.log`（exit 0，node_modules 只剩 api+base）→ `obs/roster-phase2.json`：`crypto-trader|broken=yes`，reason=「2 rows name plugins that cannot be resolved: @dsh-trading/connector-binance / @dsh-trading/kit-crypto」（S3 broken 语义），boot exit 0 无崩溃；`logs/03-readd-crypto.log` → `obs/roster-phase3.json`：`broken=no` 恢复 |

## 验收中发现的修复（已随实现 commit 交付，28 测试仍绿）

1. **isolate realm 键名错误（上次修复点真正根因）**：preset 资产组行写的是
   `isolate: {tradingCrypto: true}`，而 connector provide 的服务键是 `tradingCryptoMarketData`
   —— 键名不匹配导致服务未被 realm 私有化，挂载被 dsh-agent-presets 以
   「published process-global service(s)」拒绝。已改为 `isolate: {tradingCryptoMarketData: true}`
   （对照官方 cordis preset：isolate 键 = 服务名）。修复后 mount 成功（验收项 3）。
2. **kit-crypto peer 声明缺失导致构建内联**：kit import 了 `@deepseek-ai/dsh-tools` /
   `@deepseek-ai/schemastery` 但未声明 peer，tsdown 将其按 file: 依赖内联进 lib
   （陈旧 vendor 树含 `createRequire('../package.json')` → profile 内 import 直接崩）。
   已补齐 peer 声明（与 base 对齐），重建后 lib 仅 2 文件、bare import。
3. **profile 依赖解析坑（新增入账）**：base 依赖 `@deepseek-ai/dsh-agent-presets@0.1.2-alpha.1`
   为本地 tag、npm 无此版本 —— profile `pnpm-workspace.yaml` overrides 追加
   `link:/Users/zcl/code/deepseek-harness/packages/preset/agent-presets`（append-only 追加，
   同 smoke 先例）。

## 证据索引

```
spikes/acceptance/
├── REPORT.md                # 本报告
├── PROMPT.md                # (acceptance-PROMPT.md) 任务提示词存档
├── overlay.yml              # --patch 注入层：disabled headless-runner + observer 行（临时）
├── acc-plugin/              # 临时验收插件（plain 依赖，不进交付包，不注册 bundle）
├── logs/
│   ├── phase1-boot.log      # 安装态 boot（roster/隔离/闸门/skill 全输出，exit 0）
│   ├── 01-dump-config.log   # 组合树（凭据已脱敏）
│   ├── 02-remove-crypto.log # 卸载 crypto bundle
│   ├── phase2-boot.log      # 卸载态 boot（broken 观察，exit 0）
│   ├── 03-readd-crypto.log  # 重装 crypto bundle
│   └── phase3-boot.log      # 重装态 boot（恢复观察，exit 0）
└── obs/
    ├── roster-phase1.json   # roster + resolve('crypto-trader')
    ├── isolation-phase1.json# 双 agent 工具/skill 可见性 + 挂载成功
    ├── gate-phase1.json     # dryRun 回执 / 实盘拒绝原文
    ├── roster-phase2.json   # broken 行 + 完整 reason
    └── roster-phase3.json   # 重装后恢复
```

## 遗留说明（非阻塞）

- `spikes/impl-b/verify/verify-task-b.mjs` 引用已迁走的 `installPreset`（历史 spike 证据，
  按原样保留，不代表现 API）。
- 临时验收插件留在 profile（plain 依赖，无 bundle 行，不参与组合；overlay 仅 `--patch` 时生效）。
