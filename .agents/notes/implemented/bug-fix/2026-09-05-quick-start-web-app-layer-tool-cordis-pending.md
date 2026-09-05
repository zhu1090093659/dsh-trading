# Agent Note: npm 新装 profile 启动即崩——quick start 缺 web 宿主层，tool-cordis 服务悬空 pending（issue #62）

Status: implemented

## Problem

外部用户按 README quick start 在全新机器执行
`dsh plugin --profile trading-web add @dshtrading/base @dshtrading/crypto @dshtrading/us @dshtrading/cn @dshtrading/hk`
后 `dsh --profile trading-web` 启动即崩（issue #62，dsh 0.1.2-rc.1 实测截图，
本机独立 DSH_HOME 逐字复现）：

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
@deepseek-ai/dsh-tool-cordis: pending (waiting for services: dynamicCordisRunner, cordisInspect)
```

同一机制命中本仓无 web 层 profile：`trading-dev`/`trading-all`（dsh-headless
模板）的 `--dump-config` 组合树里有 `dsh-trading-dynamic-capabilities` 行而无
`cordis-host-runner` 行，与复现 profile 结构同构（headless 面无任务时的 usage
退出早于激活断言，未实测真崩；默认 boot 路径已实测同构即崩）。

## Root Cause

两层事实叠加：

1. **服务提供方只在 web 层**。`@deepseek-ai/dsh-tool-cordis` 硬 inject
   `dynamicCordisRunner` + `cordisInspect`；全宿主唯一提供这两个服务的包是
   `@deepseek-ai/dsh-cordis-host-runner`，而它只被 `@deepseek-ai/dsh-web-app`
   依赖激活（web-app bundle patch 的 `cordis-host-runner` 行）。cordis 无可选
   inject 语义，entry `inject` 选项只能增不能删；dsh boot 的
   `assertEntriesActivated` 把 pending entry 视为致命。
2. **自定义 profile 默认没有 web 层**。`dsh plugin --profile <自定义名> add` 对
   不存在 profile 只以 `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`
   初始化（官方报错文本也引导用户这么建）；web/headless/acp 等内置模板才带
   `dsh-web-app`。4cc9289（P6 开放 dsh-tool-cordis）在 base patch insert 该行
   后，任何「裸 dsh-base + dsh-trading」profile 从「无 web UI」升级为「启动即崩」。

本地 trading-web / desktop seeded profile 未炸，是因为二者 manifest 都手工带
`dsh-web-app` bundle 层（2026-08-29 process note 同款）——问题只在「npm 全新
quick start」与无头 profile 暴露。

## Decision

两处最小修复：

1. **`packages/base/cordis.patch.yml`**：`dsh-trading-dynamic-capabilities` 行加
   `disabled: !!js` 条件——宿主组合树存在 name 为 `@deepseek-ai/dsh-cordis-host-runner`
   的 entry（即 web/desktop profile）才启用，否则禁用该行。恢复「insert 行在任何
   宿主都安全」不变量：无 web 层的宿主降级为无动态包工具（fail-soft，与 client
   行 headless 无害同款），不再崩溃。`loader.entries()` 遍历的是组合完成的 entry
   树（只读 options，与激活顺序无关）；`!!js` 在 loader ctx 的 `with` 作用域求值，
   `loader` 是 reflect.provide 的服务、可直接引用——宿主自有行
   `disabled: !!js process.platform === 'win32'` 为同款先例。
2. **README / README_zh quick start**：add 之后加一步 node 一行命令，往
   `~/.dsh/profiles/trading-web/package.json` 的 `dsh.profile.bundles` 在
   `dsh-base` 之后插入 in-box 的 `@deepseek-ai/dsh-web-app`（幂等）。quick start
   原本就承诺「打开打印的 URL」——裸自定义 profile 连 web 服务器都没有，缺这一步
   是文档缺陷而非可省略优化；bundles 清单编辑是宿主 README 认可的 profile 数据
   模型（in-box bundle 不进 dependencies、按名从 dsh 安装解析、cohort 自动对齐）。

不改 npm 依赖：web-app 在 npm 的 `latest` dist-tag 指向坏的 0.1.1 前身
（0.0.1-rc.1，依赖未发布的 @deepseek-ai/dsh-frontend），`add @deepseek-ai/dsh-web-app`
裸装即失败；带版本号安装则把约 100 个包的闭包拉进 profile 且与宿主 cohort 漂移，
而运行时解析本就 in-box 优先，纯付 ballast。

## Alternatives considered

- **base 条件补插自己的 `cordis-host-runner` 行**（无 web 层时提供服务，无头也保
  动态包工具）：host-runner 默认导出仅 inject `tools`、可独立激活，机制可行；
  但宿主有意把该接线收在 web-app 层，base 越权补层需长期跟随宿主内部接线，且
  web profile 下与 web-app 行的互斥检测一旦失效即双重 provide。放弃，降级语义
  （无 web 层 = 无动态包工具）更符合 D5 面向交互式交易 profile 的定位。
- **quick start 改用 `add @deepseek-ai/dsh-web-app@next` 自动入 bundles**：见上，
  dist-tag 陷阱 + 依赖污染 + 未按此路径验证。放弃。
- **上游修宿主**（custom profile 默认带 web-app / tool-cordis 改可选 inject）：
  宿主只读，且属上游产品决策；本仓先自愈。

## Validation

独立 `DSH_HOME=/tmp/issue62-home`（不触碰本机运行中的 dsh web 实例与其他 profile）：

- 复现：npm 装 5 个 @dshtrading 包 → 启动报错与用户截图逐字一致。
- 修复主路径：manifest 补 `@deepseek-ai/dsh-web-app` bundle 层 → 启动成功、打印
  tokenized URL（`--port 0`；3080 被本机既有 web 实例占用的 EADDRINUSE 反证插件
  树已完整激活到 webserver）。
- 条件行双向矩阵（临时手改 profile 内 base 安装副本 + 探针行 stderr 打印
  `loader.entries()` 检测结果）：裸 profile 探针 `false` → 行禁用 → 启动不崩；
  web profile 探针 `true` → 行启用 → 启动正常出 UI。探针同时证明 `loader` 在
  `!!js` 作用域可用。
- 门禁：`pnpm build`、`pnpm test` 全绿（131 文件 1058 用例通过，skip 为既有）。
- trading-dev：刷新 base 副本后 `--dump-config` 组合树带上条件行；无任务启动仍
  干净退出 usage 提示（该路径早于激活断言，本就不崩——无头面回归以组合树为准）。

## Consequences

- quick start 多一步（node 一行命令）；未来宿主若给自定义 profile 提供模板或
  bundle 管理 CLI，可收回该步。
- trading-dev/trading-all 等无头 profile 不再有 cordis 动态包工具；需要时给
  profile manifest 补 `@deepseek-ai/dsh-web-app` bundle 层即可（服务由 in-box
  解析，headless 场景无浏览器半审批通道，浏览器半 fail-closed）。
- 修复主路径（README）对已发布的 base@0.1.1 立即生效；条件行走下一个 base 发版
  才到 npm 用户手上。
