# 任务 I REPORT — 多市场联合验收 + @dsh-trading/all 单命令安装验收（dsh-trading 终验）

- 日期：2026-08-31 ｜ Profile：`trading-all`（本轮新建 scratch）｜ dsh 0.1.2-alpha.1
- 手法：复用 crypto 验收范式（`spikes/acceptance/`）——临时验收插件 `acc-plugin/`（plain 依赖 + `--patch`
  overlay 注入，`disabled: headless-runner` 杜绝模型调用）进程内读 roster、五 agent（standard + 四 preset）
  对比工具/skill 可见性、直调四市场 `*_place_order` execute。**全程 0 模型调用**；未改任何包源码。
- Profile 准备（`logs/01-profile-create.log`）：exa + headless `link:` 安装 exit 0；
  profile `pnpm-workspace.yaml` 末尾 append overrides：@dsh-trading/* 全部 15 包 `file:` 钉到本仓 +
  `@deepseek-ai/dsh-agent-presets` `link:` 参考 checkout（append-only，同 smoke/trading-dev 先例）；
  headless 宿主 profile 级 `cordis.patch.yml` 自行 insert `agent-presets` 行（照抄 `~/.dsh/profiles/trading-dev/cordis.patch.yml` 全文）。

## 结论：联合验收 6/6 PASS；**单命令验收 FAIL（新 bug，已记录待主 agent 裁决，未修）**

### 单命令验收（任务 1）——**FAIL**

`dsh plugin --profile trading-all add @dsh-trading/base @dsh-trading/all` exit 0，
pnpm `Packages: +14`（`logs/02-single-command-add.log`）——**依赖闭包解析成功**：
node_modules/@dsh-trading 落齐 14 包（connector-stooq 无依赖方被正确剪枝）。
**但组合树只有 `# == @dsh-trading/base` 一层**：四个市场 bundle 是 all 的传递依赖，
不进 profile 的 `dsh.profile.bundles` 层栈 → 安装器行缺失 → preset 不自装 → 四市场**静默缺失**（boot 不报错）。

**根因（源码抽核，报告主 agent，未改）**：`deepseek-harness/apps/cli/src/plugin.ts` `reconcilePlugins()`
只扫 profile manifest 的**直接依赖**里声明 `dsh.bundle` 的包加入层栈（"a dependency resolving to a package
that declares dsh.bundle joins the layer stack"），不做传递展开。S5 TEMPLATES 的设计前提
「all 元 bundle——只叠 bundles 顺序」在该 DSH 版本不成立；`all` 的 patch 为 `[]`，卸载它树也零变化
（`logs/07-remove-all.log` + 安装态/卸载态 dump 全等），即 all 对层栈**装/卸双向皆 no-op**。
联动坑：known-pitfalls「patch 打不存在的行仅警告——静默落空」同款失败形态，但发生在 bundle 层栈维度。

**验收绕行（仅 profile 层操作，未动包源码）**：显式 `dsh plugin add @dsh-trading/crypto @dsh-trading/us
@dsh-trading/cn @dsh-trading/hk`（`logs/04-explicit-market-adds.log`），四市场 bundle 成为直接依赖后
reconcile 正确入栈（层序 all→base→cn→crypto→hk→us，base 共享行在前，insert-only 语义不变）。
**修复建议（三选一，请主 agent 裁决）**：① dsh plugin add 递归展开传递 bundle 依赖（改 DSH 侧，需上游协商）；
② `@dsh-trading/all` 改为自身插入四安装器行（违反 insert-only 层所有权铁律 #1，不建议）；
③ 安装口径改为文档化「base + 四市场显式 add」，all 降级为纯依赖闭包载体并在 README 标注限制。

### 联合验收（任务 2，四市场 bundle 显式入栈后）——6/6 PASS

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| a | boot exit 0；dump 四市场安装器行 + base 两行齐全；市场层 insert-only | **PASS** | `logs/06-phase1-boot.log` exit 0；`logs/05-dump-config-installed.log`：`# == @dsh-trading/base`(:357) `dsh-trading-base-gate`(:358)，cn/crypto/hk/us 层(:360/363/366/369) 各含 `dsh-trading-*-installer`(:361/364/367/370)，`agent-presets`(:373，profile 层 insert)。insert-only 直证：安装态 vs 卸载态 dump diff **恰好只有四市场层 12 行整块消失**（`logs/09` diff），官方/base 行零改动；且卸载→重装全周期 dump **逐字节一致**（`FULL-CYCLE DUMP IDENTICAL`，见 logs/12 前置 diff） |
| b | roster 含四 preset、broken=null | **PASS** | `obs/roster-phase1.json`：crypto-trader/us-trader/cn-trader/hk-trader 全部 broken=null、trust=user；`presets.resolve()` 各返回安装路径 `~/.dsh-trading-presets/<名>/agent.cordis.yml`；安装文件与包资产 `cmp` **4/4 逐字节一致**（幂等直证） |
| c | 逐市场隔离 + standard 全不可见 + 交叉污染 | **PASS** | `obs/isolation-phase1.json` 五 agent 同进程矩阵：join 各市场的 agent 仅见本市场工具（crypto 4/us 3/cn 3/hk 3，`ownToolsAllVisible=true, foreignToolsVisible=[]`）；standard 13 工具全 false、4 checklist 全 false；**cn-trader scope 的 `hk_*` 工具可见性 = []（hk scope 反向亦然）**——connector-tencent 单包双市场多实例（行 id 分流 + isolate 键 `tradingCnMarketData`/`tradingHkMarketData` 分流）隔离成立；五次 `presets.mount()` 零拒绝（多 isolate realm 并存直证） |
| d | 每市场下单闸门抽查 | **PASS** | `obs/gate-phase1.json`：四市场各自 joined scope 内直调 execute——`dryRun=true` 一律 `{"status":"filled","dryRun":true,"note":"DRY-RUN — simulated fill…"}` 模拟回执；`dryRun=false`+`liveTrading=false` 一律 `{"status":"rejected","code":"TRADING_LIVE_TRADING_DISABLED",…}` 结构化拒绝（闸门模式 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/` 覆盖实测） |
| e | skill 目录四个 *-risk-checklist 各归其 preset scope | **PASS** | `obs/isolation-phase1.json`（agent scope 视图 `list({scope})`）：crypto/us/cn/hk 四 scope 各自仅见本市场 checklist（`checklists` 每行恰一 true），standard 全无；各 scope skillCount=34/34/34/34 |
| f | 卸载变 broken 不崩、重装恢复 | **PASS** | `logs/08-remove-markets.log` exit 0（node_modules/@dsh-trading 仅剩 api+base）→ `obs/roster-phase2.json`：四 preset `broken=yes`，reason **逐行指名不可解析包**（如 crypto：「2 rows name plugins that cannot be resolved: dsh-trading-crypto-connector-binance→@dsh-trading/connector-binance、dsh-trading-crypto-kit→@dsh-trading/kit-crypto」；cn/hk 各指 connector-tencent + kit，同包双实例 reason 各自正确），boot exit 0 无崩溃；`logs/11-readd.log`（+12 包）→ `obs/roster-phase3.json`：四 preset broken=no 全部恢复 |

## 交付物与遗留

- 本轮**零包源码改动**，无回归义务（基线：cn+hk 切片交付时 14 包/73 用例全绿，见 replication.md §8）。
- 临时验收插件 `acc-plugin/` 与 `overlay.yml` 留在 profile（plain 依赖无 bundle 行不参与组合；overlay 仅 `--patch` 时生效），同 task D 先例。
- 遗留 1（bug，阻塞「单命令装齐」卖点）：见上，待主 agent 裁决修复方向后补一轮单命令复验。
- 遗留 2（非阻塞）：`dsh-trading/base` 自身 patch 的 `agent-presets` 同 id 覆盖条目在 headless 宿主仍按设计警告跳过（dump 第 1 行 `entry "agent-presets" not found`），headless 由 profile 级 patch 兜底——与既有部署约定一致，非本轮缺陷。

## 证据索引

```
spikes/acceptance-all/
├── REPORT.md                  # 本报告
├── PROMPT.md                  # 任务提示词存档（acceptance-all-PROMPT.md 副本）
├── overlay.yml                # --patch 注入层：disabled headless-runner + observer 行（临时）
├── acc-plugin/                # 临时多市场验收插件（plain 依赖，不进交付包，不注册 bundle）
├── logs/
│   ├── 01-profile-create.log          # profile 新建 + exa/headless link: 安装
│   ├── 02-single-command-add.log      # 单命令 add base+all：Packages: +14（闭包解析成功）
│   ├── 02b-add-observer.log           # observer plain 依赖入 profile
│   ├── 03-phase1-boot.log             # 首次 boot（市场层缺失暴露，observer 报 UnknownPreset）
│   ├── 04-explicit-market-adds.log    # 四市场 bundle 显式 add（绕行，层栈入栈）
│   ├── 05-dump-config-installed.log   # 安装态组合树（六 trading 层 + profile 层）
│   ├── 06-phase1-boot.log             # 联合验收 boot（roster/隔离/闸门/skill 全输出，exit 0）
│   ├── 07-remove-all.log              # 卸载 @dsh-trading/all（树零变化 = bug 双向 no-op 直证）
│   ├── 08-remove-markets.log          # 卸载四市场 bundle
│   ├── 09-dump-config-markets-removed.log # 卸载态 dump（与 05 diff = 12 行市场层，insert-only 直证）
│   ├── 10-phase2-boot.log             # 卸载态 boot（broken 观察，exit 0）
│   ├── 11-readd.log                   # 重装（+12 包）
│   └── 12-phase3-boot.log             # 重装态 boot（恢复观察，exit 0；前置含全周期 dump 全等 diff）
└── obs/
    ├── roster-phase1.json     # 四 preset broken=null + resolve 安装路径
    ├── isolation-phase1.json  # 五 agent 工具/skill 矩阵 + 交叉污染检查 + 挂载成功
    ├── gate-phase1.json       # 四市场 dryRun 回执 / 实盘结构化拒绝原文
    ├── roster-phase2.json     # 四 preset broken 行 + 逐行不可解析包 reason
    └── roster-phase3.json     # 重装后恢复
```
