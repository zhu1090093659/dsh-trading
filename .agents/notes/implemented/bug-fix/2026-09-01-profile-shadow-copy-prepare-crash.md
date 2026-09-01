# Agent Note: trading-web 会话运行崩 reading 'prepare'——profile 影子拷贝割裂宿主模块实例

Status: implemented

## Problem

宿主 CLI 升到 `@deepseek-ai/dsh@0.1.2-alpha.3` 并重启 trading-web 后，任何
**使用工具的**会话运行必崩：`本轮运行失败 Cannot read properties of undefined
(reading 'prepare')`（code UNKNOWN）。纯文本回复永远正常——「能聊天、一干活
就崩」。user 报告后一度被误判为「升级窗口状态竞态、已自愈」（该结论错误，
被 user 的复测推翻）。

## Root Cause（真实网络 + 模块解析实证）

1. 失败点在 agent-loop 的工具调度读取：
   `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)`（dsh-agent-loop）。
   `TOOL_RUNTIME_SCHEDULER` 是 dsh-tools 的**模块级 Symbol**，跨模块实例互不相认。
2. trading-web profile 的 node_modules 里物化了一份 **dsh-tools@0.1.2-alpha.2**
   影子拷贝（pnpm-lock 残留 α2 cohort + minimumReleaseAgeExclude 钉在 α2；
   knowledge 包下还有嵌套拷贝）。宿主 α3 agent-loop 读 α3-Symbol，而
   `tools` 服务实例由 profile 影子拷贝（α2）提供 → Symbol 对不上 →
   `scheduler` 为 undefined → 每次 run_code/工具调度必崩。
3. 排除项（均已实证非根因）：α3 移除 SQLite 存储后端（组合树只有
   storage-json/jsonl，`~/.dsh/sessions.sqlite` 与 `data.db` 是 0 字节无引用
   空壳）；boot 期 loader 失败（--dump-config 与 boot 日志干净）；纯血
   `web` profile 对照（工具任务全部正常，宿主 α3 无回归）。

## Decision

1. **profile 内与宿主 CLI 树重叠的核心包全部 symlink 到宿主单一实例**：
   `dsh-web-app / dsh-tools / cosmokit / schemastery / dsh-agent-presets /
   dsh-brand / dsh-util-values`（含 knowledge 包下的嵌套 dsh-tools）。
   Node ESM realpath 后与宿主同模块 URL → Symbol/模块状态归一。
2. 固化为 `scripts/refresh-trading-web-profile.sh`：停实例 → 刷
   @dsh-trading 副本 → `dsh plugin install` → **重挂宿主 dedupe symlink**
   （pnpm install 会重新物化影子拷贝，此步不可省）→ 提示重启。
3. **否决的备选**：package.json 里加 `link:` 依赖做原生 symlink——会让
   loader 对同一包组合出两条 entry（如 `subagent-model-selection-settings`
   duplicate）直接 boot 失败；overrides 里用 `link:` 则触发 pnpm 11
   "Cannot convert undefined or null to object"。均不可用，symlink 重挂
   由脚本承担。
4. `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 升到 α3 cohort
   （α3 发布于 2026-08-31，age 闸门会把它压回 α2）。注意 pnpm 的 hoist
   冲突仍可能让 base 的 `>=α1` 依赖边物化 α2 实体——脚本的 symlink 重挂
   是最终兜底，不能依赖解析层。

## Verification

- 修复前：强制工具任务（`ls /Users/zcl/code`）→ 必崩 prepare（多实例复现）。
- 修复后：同任务返回真实 `ls` 输出；`/dshtrading/api/tickers` 桥正常
  （AAPL prevClose 319.7）；纯血 web profile 对照全绿。

## Consequences

- **纪律**：宿主升代后必须跑一次本脚本（先 pnpm build 仓库），不能只
  `dsh plugin install`——后者保留 α2 锁定分辨率并重新物化影子拷贝。
- 排错教训：「reading 'prepare'」这类消息先看属性名是字面量还是 Symbol——
  Symbol 键的 undefined 读取报的是 Symbol 描述，据此可区分「实例缺字段」
  与「实例本身缺失」。对照实验（纯血 profile）早做，比静态读码快。
- dsh-web 侧若出现同症状（任何 link/独立 profile 携带 @deepseek-ai 影子
  拷贝的场景），同款 dedupe 思路适用。
