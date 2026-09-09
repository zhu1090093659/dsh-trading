# Agent Note: 桌面壳启动闪退——profile 副本手工部分拷贝混世代，叠加会话级 DSH_HOME 把标准刷新带偏到旧 home

Status: implemented

## Problem

2026-09-09 下午优化合入后（b631927、b16cf36、1cb5402、3ca04d1 及 15:19/15:20 两个 merge），用户从 Dock 启动 DSH Trading 桌面壳直接闪退。宿主日志（~/Library/Logs/dsh-trading-desktop/dsh-host.log）证据链：

- 宿主 boot 报 `ERR_MODULE_NOT_FOUND`：`.../@dshtrading/client-ui-trading/lib/ttl-cache.js` imported from `.../lib/bridge.js` → `plugin tree failed to load` → 宿主 `exited: code=1`。
- 桌面壳随后 `boot failed: ERR_ABORTED (-3) loading .../error.html` 并退出——即"闪退"。
- `ttl-cache` 是当天 b631927（基本面缓存有界 TTL+LRU）引入的新模块，仓库构建产物 `packages/client-ui-trading/lib` 里 17 个文件齐全。

现场检查 trading-web profile 的 client-ui-trading 副本：`bridge.js / client.js / index.js / sse.js / index.d.ts / client.js.map` mtime = 当天 15:19，目录本身与其余文件停在 08:17 安装代；`ttl-cache.js` 缺失，lib 文件数 16（仓库 17）。即有人在 15:19 绕过标准流程**手工部分拷贝**了新构建的少数文件，制造出"bridge 已是新版、新模块没跟上、子目录停在旧代"的混世代副本。

深层诱因是标准刷新通道当天被两道门卡死：

1. dsh 宿主 agent 会话的环境变量 `DSH_HOME=/Users/zcl/.dsh` 被 `scripts/refresh-trading-web-profile.sh`、`scripts/profile-config-preflight.sh` 与 `~/.local/bin/dsh-trading` wrapper 的「显式值优先」语义尊重——在 dsh 宿主里跑 agent 会话再跑仓库脚本，预检打到的是**旧 home 的 trading-web 残留 profile**（48 条 `./vendor/*-0.1.2.tgz` 死路径 + 缺 dsh-home 闭包行），假阳性 FAIL 中止。修复会话（本文写作时）第一步就中此招：FAIL 全部指向 `~/.dsh/profiles/trading-web`，而非桌面壳实际使用的 `~/.dsh-trading`。
2. 旧 home 残留 profile 实际仍在（[separate-dsh-home](../process/2026-09-08-separate-dsh-home.md) 写的是「不复存在」，与现实不符），谁从这里跑脚本就被它劫持。

下午会话大概率同样被假 FAIL 挡住标准通道，才改走手工拷贝的歪路。

## Decision

1. **修复走标准通道**：重建两个过期包（strategies、client-ui-trading）后，显式 `DSH_HOME=$HOME/.dsh-trading bash scripts/refresh-trading-web-profile.sh`——预检通过（63 条 file:/link: 行）→ 删全部 `@dshtrading/*` 副本 → `dsh plugin --profile trading-web install` → 重挂宿主核心包 symlink。副本恢复单一世代：46 包全部 0.1.6，client-ui-trading lib 17/17 文件与仓库一致，`ttl-cache.js` 到位。
2. **纪律固化：profile 副本刷新一律走 refresh 脚本（或删整包目录后 plugin install），禁止手工挑文件拷贝。** preflight 第 4 类（版本漂移）注释里已记了 trading-all 混世代启动崩（2026-09-09 上午），本次是同族失败模式在 trading-web 上的第二个实证——两次都是"局部刷新/手工拷贝"造成。
3. **登记 follow-up（未实现）**：(a) 仓库脚本加守卫——`DSH_HOME` 解析到 dsh web 宿主 home（`~/.dsh`）时报警中止，或至少打印解析后的 home 根；(b) 清理或归档 `~/.dsh/profiles/trading-web` 残留（0.1.2 世代，含已不存在的 dsh-session-archive / dsh-im 插件行）。

## Verification

- 模拟 Dock 启动（`env -u DSH_HOME open -a "DSH Trading"`）：日志 `[desktop] dsh home: /Users/zcl/.dsh-trading`、宿主进程存活、`dsh web: http://127.0.0.1:<port>/?token=...`、`GUI ready, loading the tokenized URL`。
- 对照证据：带会话环境 `DSH_HOME=/Users/zcl/.dsh` 启动则 `[desktop] dsh home: /Users/zcl/.dsh`，宿主崩在旧 home profile 的 dsh-session-archive / dsh-im 缺包上——证明桌面壳尊重显式环境变量、且旧 home 残留确实会崩，本次修复与用户的 Dock 路径无关。
- UI 验证按 [ui-screenshot-verify 手法]：宿主 HTTP curl 303（token 鉴权重定向，存活证据）+ 无头 Chrome `--timeout` 截图——自选列表（加密/美股/A股/港股）、行情/策略/知识库页签、K 线面板完整渲染。
- 仓库工作树零改动（纯环境修复），pnpm build 产物新鲜度对齐 main。

## Alternatives considered

- **只补拷 `ttl-cache.js` 单文件**：动作最小，但副本仍是 15:19 半新半旧混合体（`client/`、`tasks/` 子目录停 08:17 代），preflight 版本漂移 FAIL 不会消失，下次改动再爆——拒绝，按 FAIL 提示全量重装。
- **立即清理旧 home 残留 profile**：清理 `~/.dsh` 属用户 home 数据，需用户拍板，且不解决会话变量劫持本身——登记 follow-up，不阻塞修复。
- **改桌面壳语义：显式 `DSH_HOME` 也强制 `~/.dsh-trading`**：违反 [desktop default trading home](2026-09-08-desktop-default-trading-home.md) 的「显式覆盖」设计，且本次误启动是修复会话自己的环境问题，不该改产品语义——拒绝。

## Consequences

- trading-web profile 副本回到单一 0.1.6 世代；profile 内 `@deepseek-ai/*` 链接方向随最后启动者变化（本次末次启动者为桌面壳，符合 [cohort note](2026-09-08-desktop-preset-context-injection.md) 的既定行为）；CLI 验证前仍需跑 refresh 脚本。
- **agent 会话内跑本仓脚本的人工纪律（守卫落地前）**：dsh 宿主会话环境带 `DSH_HOME=~/.dsh`，凡跑 refresh / preflight / plugin install 前必须显式 `DSH_HOME=$HOME/.dsh-trading`；wrapper「显式值优先」对 agent 会话不是保护而是陷阱。
- 旧 home trading-web 残留的存在与否以本文为准（separate-dsh-home 的「不复存在」表述已被证伪），待用户决定清理方式。
- 本 note 为事件记录 + 流程纪律，无仓库代码变更。
