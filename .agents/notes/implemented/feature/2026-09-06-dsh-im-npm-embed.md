# Agent Note: npm 内置社区 IM 机器人插件 @xmanrui/dsh-im

Status: implemented

## Problem

dsh-trading 缺少 IM 机器人入口：交易分析无法从飞书/微信/钉钉等 IM 渠道直接对话
发起，结果文件也无法回传到 IM。社区插件 `@xmanrui/dsh-im`（4.13.0 世代）已成熟
实现九渠道（飞书/微信/钉钉/企业微信/QQ/Slack/Telegram/Discord/WhatsApp）机器人
接入：流式回复、图片识别、结果文件回传、扫码/Manifest 接入引导，且其
`dsh.compatibility.dsh` 明确声明兼容本仓宿主世代 `0.1.2-rc.1`，engines
`node >=22.19` 与本仓一致。重写等价实现纯属重复劳动，按
[session-archive 同款 npm 复用范式](2026-09-06-session-archive-npm-reuse.md)
直接内置。

## Decision

- base 包（`@dshtrading/base`）新增 npm 依赖 `@xmanrui/dsh-im@^4.11.0`。
  选版纪律：落地时刻（2026-09-06T08:28Z）4.13.0（5h）/4.12.0（16h）尚在
  pnpm 11 `minimumReleaseAge` 24h 冷却期内，`^4.11.0`（36h 前发布）是冷却期
  合规的最新 4.x，lockfile 收录 4.11.0；待 4.12/4.13 出冷却后 `pnpm update`
  在 caret 范围内自然跟进。不为追新版给第三方插件开
  `minimumReleaseAgeExclude` 豁免（session-archive 同款纪律）。
- base cordis.patch.yml 追加 insert 行 `dsh-trading-im`，name 指向包本身
  （与上游自带 patch 的行语义完全一致，仅 id 归入本仓 `dsh-trading-*`
  命名空间）。单行双半：host 半（九渠道连接/流式回复/凭据写入宿主受保护
  凭据存储）+ 浏览器半（设置 → IM机器人 配置面，section order 21，与
  client-ui-updater 的 order 20 相邻不冲突）。
- 市场无关共享行归 base 唯一所有（铁律 #1），市场 bundle 不复制该行。
- 包名进 base dependencies 保证 profile 安装闭包可解析（S3 坑 3 同款），
  随 `scripts/refresh-trading-web-profile.sh` 刷新进 trading-web；
  trading-dev/trading-all 及桌面 seeded profile 经 base 依赖闭包同步获得。

## Alternatives considered

- 源码 fork 进本仓 packages/：维护双份实现，上游迭代节奏极快（4.x 一个月
  30+ 发布），手工同步不可持续，未采用。
- 只在 trading-web profile 层加依赖（不动 base）：IM 渠道是市场无关能力，
  拆在 profile 层会造成各 trading profile 各自维护、桌面 seed 拿不到，
  且违反「共享行 base 唯一拥有」铁律 #1，未采用。
- 给 `@xmanrui/dsh-im@4.13.0` 开 minimumReleaseAgeExclude 追最新版：为
  单个第三方包绕过供应链冷却期不值得，等 24h 自然出冷却，未采用。

## Consequences

- trading-web 重启刷新后，设置面板出现「IM机器人」（order 21），各渠道
  扫码/填凭据后即可在 IM 里对话本仓 trading agent；headless profile 仅
  host 半 webServer 注入挂起（client-ui-updater 同款无害模式），未配置
  凭据时各渠道空闲待命。
- **勿重复安装**：本行即内置，再对 profile 执行
  `dsh plugin add @xmanrui/dsh-im` 会把上游自带 patch（id
  `xmanrui-dsh-im`）追加进来，同一插件双行挂载、设置面二次注册。
- 升级通道 = npm `^4.11.0`（4.x 内 caret 自动），上游破格升 5.x 需人工
  评估 compatibility/cohort 一致性。
- 本仓只消费不发布；插件问题上游修，必要时 lockfile 钉版过渡。
- 新增外部信任面：@xmanrui scope 及其渠道 SDK 闭包（qqbot/wecom/
  dingtalk-stream/undici 等）随 profile 安装闭包执行，凭据面由上游设计
  限定为宿主受保护凭据存储（状态接口不回传 Secret）。
