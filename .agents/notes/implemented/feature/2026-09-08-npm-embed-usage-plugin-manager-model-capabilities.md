# Agent Note: npm 内置 dsh-web 使用统计/插件管理/模型能力三插件

Status: implemented

## Problem

trading-web 的 web GUI 缺三块运维面：① 模型用量与花费不可见——token 消耗、各 provider
余额/套餐配额、今日 DeepSeek 花费都只能去各家控制台看；② 插件管理只有官方「插件配置/
插件列表」，没有安装/更新/卸载/启停的管理入口，社区连接器与指标插件只能手敲 CLI；
③ 自定义 `llm-pi-ai` provider 的模型能力（图片输入、推理档位）在官方模型页无处声明，
只能手改 settings.yaml。

dsh-web 项目（同作者维护的 web 插件库）已成熟实现这三块，并已发布 npm：
`@linxin666/dsh-usage`（用量账本 + 余额/套餐探针 + 设置一级菜单）、
`@linxin666/dsh-client-ui-plugin-manager`（官方插件区管理标签页 + 双通道写路径）、
`@linxin666/dsh-client-ui-model-capabilities`（模型页 provider 卡片能力编辑器）。
三者 `dsh.engines.dsh` 均为 `>=0.1.2-rc.1`，与本仓宿主 cohort 一致；发布产物与本地
dsh-web 源码 `lib/` 逐字节一致（npm pack 后 diff 全等，供应链核对通过）。重写等价实现
纯属重复劳动，按 [session-archive 同款 npm 复用范式](2026-09-06-session-archive-npm-reuse.md)
直接内置。

## Decision

- base 包（`@dshtrading/base`）新增三个 npm 依赖，并追加三条 insert 行
  （id `dsh-trading-usage` / `dsh-trading-plugin-manager` / `dsh-trading-model-capabilities`，
  name 指向包本身）：市场无关共享行归 base 唯一所有（铁律 #1），市场 bundle 不复制。
- **选版纪律**：落地时刻（2026-09-08T14:52Z）0.3.18 尚在 pnpm 11 `minimumReleaseAge`
  24h 冷却期内，usage / plugin-manager 取 `^0.3.17`（lockfile 收 0.3.17）；
  model-capabilities 只有 0.3.18 一个版本（当日首发），pnpm 自动把它记入
  `minimumReleaseAgeExclude`（工具自身行为，非人工豁免），出冷却后 `pnpm update` 自然跟进。
- **适配点 1（使用统计）**：insert 行带 `config.bubbleMode: off`——本产品不内置
  `dsh-pet`，宠物气泡没有宿主；该键在插件自己的设置面板里可随时改回 always/change，
  属用户可见项。账本与探针快照落 `$DSH_HOME/dsh-usage/`（DSH_HOME=~/.dsh-trading），
  与宿主 `~/.dsh` 隔离，符合独立 home 纪律。
- **适配点 2（插件管理写路径）**：该插件的 host 半在 npm 发布版 web 运行时走
  loopback 网关、派生官方 `dsh` CLI 写 profile（唯一写者），CLI 解析顺序 =
  宿主 PATH → 宿主入口向上 `node_modules/.bin/dsh` → darwin `/opt/homebrew|/usr/local/bin/dsh`。
  桌面壳自带 runtime 构建期会删掉全部 pnpm `.bin` 目录（符号链接不能进安装包），
  Dock 启动又只有最小 PATH，桌面用户没有全局 CLI 时写路径直接不可用。故
  `desktop/scripts/build-runtime.mjs` 在 stage 之后写回
  `runtime/host/node_modules/.bin/dsh`（POSIX 脚本）与 `dsh.cmd`（Windows），
  两个平台共用同一份平台无关 host 树；生成器落在 `desktop/src/runtime.cjs`
  （`hostCliShimPath` / `writeHostCliShims`，纯函数 + 单测，含真机执行断言），
  构建期 `assertRuntimeEntrypoints` 校验垫片存在。
- **适配点 3（模型能力）**：本仓 `llm-pi-ai` 路由（kimi-coding / zai-coding-cn / zenmux /
  基元 / ollama pro）正是该卡片的适用面，能力声明直接生效；`llm-deepseek` 固定目录不在
  覆盖范围（官方能力面自带），无需改动。
- **i18n 无需补位**：三个插件的词典注册为 `zh`/`en`；宿主语言目录里 zh-CN 的 fallback
  链是 zh-CN → zh → en，实测三块界面在 zh-CN 下全部渲染中文（截图证据）。
- **隐私面披露**：plugin-manager 浏览器半每次加载向 dsh-market.com 发一次匿名安装心跳
  （随机 localStorage id + 包名，无对话数据、无 IP、每日去重），README 隐私节已如实写明。

## Alternatives considered

- 源码 fork 进本仓 `packages/`：获得完全控制但维护双份实现，dsh-web 迭代快，
  手工同步不可持续（session-archive / dsh-im 同款否决）。
- 走 `@linxin666/dsh-web-all` 全家桶聚合行：一次拖进 17+ 个与本仓无关的 web 插件
  （皮肤/宠物/SSH/远端 UI 等），profile 闭包膨胀且行为面不可控。
- 不给桌面壳补 CLI 垫片、只写文档让用户装全局 CLI：桌面安装包的产品承诺是「零预装
  工具链开箱即用」，插件管理写路径在桌面版失效等于只交付半张功能。
- 给使用统计保留 `bubbleMode: always`（上游默认）：本仓无 pet 插件，属死配置；
  显式 off 才是本产品的真实意图。

## Consequences

- trading-web / 桌面 profile 重启后：设置面板出现「使用统计」一级菜单（order 151）、
  「插件」区出现「插件管理」标签页、模型页各自定义 provider 卡片出现「模型能力」区。
- 实测证据（trading-web 同构 profile，宿主 HTTP + 无头 Chrome 截图）：
  `/api/dsh-usage/overview` 返回真实余额（DeepSeek ¥983.66、kimi-coding 套餐窗口）、
  `/api/plugin-manager/mode` 返回 `{"official":false}`（网关模式就位）、
  模型页 5 个自定义 provider 均渲染「模型能力」入口、插件管理页列出已装插件并可检查更新。
- 桌面版插件管理写路径依赖构建期垫片：旧安装包（无垫片）需重新打包才生效；
  垫片不改变 profile 语义，只恢复官方 CLI 的可发现路径。
- 新增外部信任面：`@linxin666` scope 三包随 profile 安装闭包执行（依赖仅
  schemastery / yaml）；升级通道 = npm caret，上游破格升版需人工评估 cohort 一致性。
- **已知独立问题（本变更无关，需单独跟进）**：`@dshtrading/base/presets` 的
  `inject: { loader: { await: true } }` 在本机当前环境下自锁——loader 服务的就绪检查
  把 presets 自身未完成的 init 也计入待办，于是永远不就绪，宿主 100% CPU 挂起、不打印
  启动 URL。A/B 证据：把 base patch 换回 HEAD 版本（不含本变更三行）的干净 profile
  副本同样挂起；禁用 presets 行后 4 秒启动成功。2026-09-08 21:33 的桌面实例与
  22:54 的首次验证启动均正常，此后复现稳定，与本变更无因果。定位手段：
  `kill -USR1 <pid>` 开 inspector 后 `Debugger.evaluateOnCallFrame` 列出
  `fiber.inertia` 非空条目 = `@dshtrading/base/presets`。
