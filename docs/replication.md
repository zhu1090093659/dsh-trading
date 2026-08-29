# 市场复制手册（replication playbook）

从零复制一个新市场（下文以 `us` 为例）的全程 checklist。每条注明实证出处（spike 报告 / commit / 源码:行号）；未经本仓实证的机制断言一律标「待验证」。模板总纲：`spikes/s5-scaffold-design/TEMPLATES.md`（§4 插件包 / §5 bundle 包 / §8 命名）。参照物：crypto 切片（`packages/{api,base,connector-binance,kit-crypto,crypto}`，验收 `spikes/acceptance/REPORT.md`）。

---

## 1. 建包清单（三件 + 复用两件）

- [ ] **复用 `@dsh-trading/api`**（不改）：市场契约已在其中；如需市场专属服务类型，走模块增强声明 ctx 键（实证：`packages/connector-binance/src/index.ts:5`——`tradingCryptoMarketData` 由 api 模块增强声明）。
- [ ] **`@dsh-trading/base` 不动**：统一审批闸门 + agent-presets root 行是市场无关共享行，只由 base 拥有（README 铁律 #1/#4；`packages/base/cordis.patch.yml` 头注）。
- [ ] **建 `@dsh-trading/connector-<券商/数据源>` 插件包**：模板 TEMPLATES §4；最小改动面 = ①包名/描述，②`export const name = 'dsh-trading-us-connector-<源>'`（行 id 同值），③Config schema（`dryRun` 默认 true、`liveTrading` 默认 false，`packages/connector-binance/src/index.ts:35-40`），④provide 服务键 `tradingUsMarketData`，⑤`<market>_*` 工具注册。SDK 只声明 peerDependencies（TEMPLATES §4:138-141；实证反例：kit-crypto 漏 peer → tsdown 内联 vendor 树 → profile 内 import 崩，acceptance REPORT「修复 2」）。
- [ ] **建 `@dsh-trading/kit-us` 插件包**：模板 = `packages/kit-crypto`（commit af5cfff）；内容 = 市场专属工具 + skill provider（`inject = ['skills']`，候选 rank 600——用户目录 100-500 天然覆盖，REVIEW-LOG S2「采纳建议」）。
- [ ] **建 `@dsh-trading/us` bundle 包**：模板 TEMPLATES §5 + `packages/crypto` 实装形态；四件套 = `package.json`（`dsh.bundle.patch` 指向 cordis.patch.yml、files 白名单含 `cordis.patch.yml` 与 `assets`、dependencies 实装 connector+kit——preset 行按 bare 包名从 profile node_modules 解析，S3 坑 3）、`cordis.patch.yml`（只 insert 本市场安装器一行）、`src/index.ts`（幂等 preset 自安装器，抄 crypto-installer）、`assets/preset/us-trader/{agent.cordis.yml,preset.yml}`。
- [ ] **版本同族**：`0.1.0`，与 `@dsh-trading/*` 家族一致（changesets `fixed` 组语义，TEMPLATES §6）。
- [ ] 检查点：`pnpm install && pnpm -r build` 全绿。

## 2. 命名约定（对表）

| 对象 | 形态（us 例） | 出处 |
|---|---|---|
| npm 包名 | `@dsh-trading/<域>-<名>` | TEMPLATES §8 |
| 插件名 = patch 行 id | `dsh-trading-us-connector-*` / `dsh-trading-us-kit` / `dsh-trading-us-installer` | TEMPLATES §8；crypto 实装 |
| 工具名 | `us_get_ticker`、`us_place_order`（**短市场前缀**，绝无 `dsh-trading-` 前缀） | README 定稿 2；commit 0ca1ea2（gate 模式曾因前缀失配修过） |
| 闸门模式 | `/^(?:crypto\|us\|cn\|hk)_(?:place\|cancel)_order$/`——新市场下单/撤单工具名必须落在此式内 | `packages/base/src/index.ts:50`（新增市场须扩此式并入 base） |
| skill 名 | `us-risk-checklist`（市场前缀命名空间） | REVIEW-LOG S2「采纳建议」；`crypto-risk-checklist` 实装 |
| 服务键 | `tradingUsMarketData`（`trading<Market>MarketData`） | `connector-binance/src/index.ts:51` |
| isolate 键 | = 服务名（`isolate: {tradingUsMarketData: true}`） | acceptance REPORT「修复 1」（键名不匹配 → 挂载被拒） |
| preset id | `us-trader`（roster id = 目录名） | crypto-installer 实装 |

## 3. 安全闸门接线清单（README 铁律 #3 / S4 修订）

- [ ] 插件 Config 含 `dryRun: boolean`（默认 **true**）与 `liveTrading: boolean`（默认 **false**）（`connector-binance/src/index.ts:35-40`）。
- [ ] 下单/撤单工具名匹配 base 闸门模式 `<market>_(place|cancel)_order`（见 §2 表）——base 的 pre-execute 监听器对模式内且 `dryRun!==true` 的调用返回 ask（`packages/base/src/index.ts` 头注；commit 116b1d2）。审批**不在**下单工具内部做（`connector-binance/src/index.ts:234` 注释）。
- [ ] 下单工具内实现三路径语义（acceptance REPORT 验收项 4 实证）：
  1. `dryRun=true`（或缺省）→ 模拟回执（`{"status":"filled","dryRun":true,…}`）；
  2. `dryRun=false` 且 `liveTrading=false` → 结构化拒绝（`code: TRADING_LIVE_TRADING_DISABLED`），**这是 headless 的唯一防线**（REVIEW-LOG S4：headless 下 ask 无应答者 = deny，fail-closed）；
  3. `dryRun=false` 且 `liveTrading=true` → 放行至 base 闸门 ask 宿主审批面（headless 下仍被 deny——特性不是缺陷）。
- [ ] 凭证一律 `ctx.credentials` 按名引用（BYOK），配置/代码里只存引用名（README 铁律 3/5；REVIEW-LOG S4「credentials refs+records 分工明确」）。
- [ ] 单测覆盖三路径（crypto 先例：connector 工具工厂独立导出便于直测，`connector-binance/src/index.ts:232`）。

## 4. preset 资产与安装器

- [ ] `agent.cordis.yml`（AGENT-PLANE 组合，`packages/crypto/assets/preset/crypto-trader/` 头注）：persona 行 + 市场工具行 + skill 行；**不持有**审批/沙箱/模型路由（host 面职责）。
- [ ] **provide 服务的行必须包组**：`id: dsh-trading-us-connector` + `name: cordis:group` + `group: true` + `isolate: {tradingUsMarketData: true}`，connector 作为组内子行（官方 standard preset 挂载硬规则；实证：commit 8f75804 + acceptance「修复 1」，不包则被 dsh-agent-presets 以 published process-global service 拒绝）。纯工具/skill 行不 provide 服务，无需 realm。
- [ ] 组行内 connector 子行的 `config` restate `dryRun: true` + `liveTrading: false`。
- [ ] `preset.yml`：name/description/order 展示元数据（crypto 同款）。
- [ ] **安装器行在 bundle 的 host 面**（patch insert `dsh-trading-us-installer` → `@dsh-trading/us`），**不在 kit**——kit 行在 preset 平面，preset 不存在则 kit.apply() 永不运行（鸡生蛋，commit 9c54ed5）；boot 即自安装、幂等（逐文件 diff 后写）、fire-and-forget 不炸 boot。
- [ ] **agent-presets root 行归 base**（`~/.dsh-trading-presets` + `trust: user`，`packages/base/cordis.patch.yml`）——市场层不得重复配置（patch 打已存在行 = 整行替换，S1 REPORT:40）；config 全键 restate 不合并（base 同文件头注）。
- [ ] 卸载不删已安装目录：broken 带原因、无崩溃（S3 REPORT broken 语义），重装后再次 apply 即恢复。

## 5. 验收 checklist（市场无关版，对照 `spikes/acceptance/REPORT.md` 6/6）

- [ ] **1 装与启动**：`dsh plugin --profile <scratch> add <file: 路径>` 后 profile boot exit 0；`--dump-config` 含 `# == @dsh-trading/base`（gate 行 + agent-presets 行）与 `# == @dsh-trading/us`（安装器行）三层（验收项 1 手法）。
- [ ] **2 preset 入 roster**：进程内 `presets.resolve('us-trader')` 返回安装路径；roster 中 `broken=null`、`trust=user`；安装文件与包资产逐字节一致（幂等直证）（验收项 2）。
- [ ] **3 会话隔离**（0 模型调用，双 agent 对比）：join us-trader 的 agent 可见全部 `us_*` 工具与 `us-*` skill；standard agent 全部不可见；`presets.mount()` 成功（验收项 3）。
- [ ] **4 闸门三路径**（joined scope 内直调 execute）：dry-run 模拟回执 / liveTrading=false 结构化拒绝 / ask→deny fail-closed（验收项 4）。
- [ ] **5 skill 在目录**：以 agent scope 视图 `list({scope})` 观察（host 视图看不到，scope 分层）（验收项 5）。
- [ ] **6 卸载/重装**：remove 后 boot exit 0，preset `broken=yes` 且 reason 指明不可解析包名；re-add 后 `broken=no` 恢复（验收项 6）。
- [ ] 回归：`pnpm -r build` + `pnpm -r test` 全绿（基线 5→6 包 / 28 用例起）。

## 6. 已知坑清单（勿再踩）

| 坑 | 结论 | 出处 |
|---|---|---|
| file: 依赖 | 裸路径 add = link: 语义不装传递依赖 → 本地分发必须 `file:` 绝对路径；file: 是安装时快照/硬链接，改码须删 profile node_modules 对应包再 install | S1 REPORT:56、README「开发期安装」 |
| 空 patch 层 | cordis.patch.yml 必须保持顶层 YAML 数组形状（loadProfile→parsePatchList 对非数组抛错）；空层写字面量 `[]`，不能只有注释 | `packages/crypto/cordis.patch.yml` 头注；本仓 spike 实证（S1 patch 语义链路） |
| ECMAScript `#` 私有字段 | cordis 服务类禁用（realm 代理按类身份炸）；用 TS 编译期 `private` | README 定稿 5；commit 80d7691 |
| 行 id 即命名空间 | 同 id 后层整行替换前层（insert-only 铁律的机制根源）；patch 打不存在的行仅警告——静默落空风险，id 拼错要靠 dump-config 核对 | S1 REPORT:40；S3 坑入账 |
| agent-presets 行位置 | 官方该行在 web-app bundle 不在 base/headless（REVIEW-LOG S3）；**两宿主不能共用 insert 写法**：insert 无 id 条目一律 append，web 上与 web-app 的行撞「duplicate loader entry id」启动崩溃（trading-web 实测，vendor/loader/lib/index.js:81）。定稿：base 用同 id 覆盖条目（web 生效/headless 警告跳过），headless 部署在 profile 级 cordis.patch.yml 自行 insert（trading-dev 即如此） | commit 见 base patch 修复（2026-08-29）；vendor/include/src/index.ts:77-125 |
| 重复行 id | loader 扁平化后对重复 id 直接抛错启动失败；insert 唯一安全场景 = id 全仓唯一的行 | 同上实测 |
| preset 插件解析 | preset 行引用的插件包必须进市场 bundle 的 dependencies，否则标 broken | S3 坑 3；acceptance REPORT 验收项 6 reason |
| peer 声明 | 插件包漏声明 SDK peer → tsdown 按 file: 依赖内联陈旧 vendor 树 → profile 内 import 崩 | acceptance REPORT「修复 2」 |
| profile pnpm-workspace.yaml | dsh 维护的 append-only，CI/脚本不得重写；SDK 钉版用 overrides 追加 | S5 修订 4；本仓 pnpm-workspace.yaml 注释 |
| home 级 patch | `$DSH_HOME/cordis.patch.yml` 对所有 profile 生效且强于 bundle 层，悬空行炸所有 profile 启动；bundle 同 id `disabled: true` 压不住 | S1 REPORT:46 |
| schedule ≠ 定时交易 | 官方 schedule 仅会话内提醒（≥5min、session-local）；自动化另案（自管 timer/webhook/cron+headless） | REVIEW-LOG S4 关键裁决 |
| 自安装位置 | preset 自安装必须在 bundle（host 面常驻）而非 kit 插件（preset 平面鸡生蛋不可达） | commit 9c54ed5；acceptance REPORT 头部 |

**待验证**（本手册不断言，复制 us 时专项核实）：us 市场数据源（Polygon/Alpaca 等）的 ToS 与凭据形态（README 铁律 5 要求逐源写明）；`dsh plugin add @dsh-trading/all` 单命令装齐的端到端行为（依赖序层栈出自 S1 对账机制，但 all 元 bundle 本身未跑过 acceptance 式验收——交付 all 时按 §5 走一遍）。

---

## 7. us 复制实测修订（2026-08-31，执行子 agent 按 §1–§4 落地后的手册修订）

数据源定案：**Stooq**（主 agent 决策）。落地 commit：feat(us)（connector-stooq + kit-us + us bundle + api 增强），基线 6 包/28 用例 → **9 包/49 用例全绿**（`pnpm -r build` / `pnpm -r test`）。§1 建包清单、§2 命名对表、§3 闸门接线、§4 preset 资产四节逐项照抄并全部成立，以下为实测发现的**手册错误/缺口**修订：

1. **手册引用的 Stooq 报价端点已死（§「数据源决策」外部事实错误）**：`https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv` 在 stooq.com 与 stooq.pl 均返回 404「The page you requested does not exist」，去 `h`、裸 symbol 变体同样 404（证据 `spikes/impl-us/r3-aapl-ticker-*.csv`、`pl-ticker-aapl.csv`）。修订：ticker 语义降级为「最新日 K 收盘价快照」，工具描述必须向模型明示不反映盘前盘后（connector-stooq `src/rest.ts` getTicker + `us_get_ticker` description）。
2. **「免费公开」有出口/账户策略前提（新坑，入 §6 坑清单口径）**：`/q/d/l/` CSV 下载在清完 stooq 官方 JS proof-of-work 挑战（GET 挑战页 → SHA-256 前缀零 → POST `/__verify` → clearance cookie，等价浏览器行为）后仍返回 `Access denied`（stooq.pl：`Odmowa dostępu`）——疑似按出口 IP/账户策略拒绝匿名下载（证据 `spikes/impl-us/REPORT.md`、`pl-klines-aapl-daily.csv`）。处理：连接器不做挑战求解/伪装（敌意自动化边界），挑战页→`TRADING_RATE_LIMITED`、Access denied→`TRADING_AUTH_FAILED`（文案指明 stooq.com 条款边界）；真实行情可用性须在允许出口复测后方可跑 §5 验收项 3/4 的真数据路径。
3. **日内分钟级未验证**：i=60/5 等在本出口同样被拒，按「待验证」口径标注；连接器已实现 i=1/5/15/30/60 映射与美东墙钟（含夏令时）时间戳解析，单测夹具覆盖，待出口可用后实测。
4. **「复用 @dsh-trading/api（不改）」按其自身机制落地时需触碰 api**：市场专属 ctx 键走模块增强声明（本手册 §1 第 1 条机制），us 据此在 api 包 Context 接口补了 `tradingUsMarketData: MarketDataService`（类型层、零运行时）。后续市场复制直接沿用：api 包的增强块是唯一允许的 api 包改动面。
5. **dsh-tools schema 先于工具 execute 校验枚举**：place_order 工具的 side/type 非法值在 schema 层即抛 `invalid arguments: …`，到不了工具内校验——单测断言按层归位（connector-stooq test/place-order.test.ts），crypto 先例未记录此分层，复制时勿把两类错误混为一谈。
6. **§5 验收未执行（按任务分工留主 agent）**：装与启动/preset 入 roster/会话隔离/闸门三路径（进程内直测已覆盖）/skill 在目录/卸载重装的多市场联合验收另行安排；本切片交付含单测级三路径直证（21 用例）。
