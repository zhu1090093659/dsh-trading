# dsh-trading 当前状态（交接事实页）

> 本页是**入库的**交接事实页（不依赖 .local/ 下的本机文件）。只写现在时事实与可复现命令。
> 逐条细节与本机环境见 .local/roadmap/CHECKPOINT.md（gitignored，仅本机可见）与各专题文档。

## 一句话

交易 bot 与 GUI 分离的路线已走到 **P5**：第 1 档 shadow 与**第 2 档 paper（OKX 模拟盘）已通过**；驱动的网页驾驶舱与移动端为**独立产物**；第 3 档小额 live 与带外退出演练**未做**（需人签署 + 在环）。

## 已完成并已验收（可复现）

| 项 | 证据 / 复现 |
|---|---|
| 仓库门禁 | pnpm gates:all ⇒ **14 通过 / 0 失败**（2026-10-08 现场复跑，14 条：build、-r test、覆盖率、typecheck、docs-link…）；test:audit 此前在 HEAD 即红（kdas-menu.test.ts 未入基线，非本轮引入），已按 owner 裁决整文件入基线后转绿 |
| P5 第 1 档 shadow | 10 分钟真实行情验收入册（消息 4864 / 坏帧 0 / 全程 aligned / 从未 halt / 退出码 0）；复现 node scripts/e2e-smoke.mjs --with-network |
| **P5 第 2 档 paper（OKX）** | 带真实 demo 凭据：Test Files 8 passed / **Tests 94 passed / 0 skipped**；GET balance 1145ms、GET positions 328ms（均带 x-simulated-trading）。记录见 docs/ops/ops-runbook.md「第 2 档执行记录」|
| 进程装配 | packages/tradectl/src/desk-process.ts：环路 + 事件泵 + **dry-run 派发**（无下单路径）+ 积压告警入审计；演练 drill/desk-process-shadow.ts 退出码即断言 |
| 额度上限 | mandate 侧已成**可执行判据**：缺声明 / Infinity / NaN ⇒ 拒绝开新仓（code=no-declared-limit）；0 是合法声明；只约束新增风险 |
| 凭据语义 | connector-okx：**存在 credentials seam 即 fail-closed**（不再回落 ambient 环境变量）；仅完全无 seam 时回落 process.env |
| 驾驶舱 | packages/cockpit：**独立 SPA**（零依赖、不复用 client-ui-*），由 bot 的 edge 行托管；只调 /v1/cards 与 /v1/commands |
| 移动端（观测端，iOS 原生） | **apps/ios-native**（XcodeGen 生成的独立 Xcode 工程，不进 pnpm workspace）：契约等价实现 + 行为向量 + **XCTest 机检**（向量/用例数随契约扩展，不写死；改错必红）；六个分层 scheme 全绿、冷构建 BUILD SUCCEEDED；CI 跑两条纯 Node 门禁（防漂移 + 分层白名单）。见 apps/ios-native/README.md |
| 移动端（Expo/RN 旧工程） | **已退役并删除**（owner 2026-10-02 决定，以 iOS 原生为准）：apps/mobile/** 用 `git rm -r` 移除、ci.yml 的 mobile job 一并删除，历史只留提交记录。裁决与理由见 [移动端落仓方案]（自动交易平面已迁往私有卫星仓 [dsh-trading-bot](https://github.com/zhu1090093659/dsh-trading-bot)） 的「去留裁决」节 |
| systemd 台架 | scripts/systemd-units-check.mjs（六类静态判据，退出码即结论）+ 人执行安装清单（deploy/README.md）。**本机无 systemd，安装未做** |
| 官方 Office 技能与依赖加载 | base 层两条官方行（id `skill-office` / `workspace-dependencies`，`DSH_PRIMARY_RUNTIME` 门控，无载荷显式缺席）。真实会话实测 catalog/provider/resourceBase、加载期注入的 LibreOffice Kit 段、`load_workspace_dependencies` 可见；DOCX/PPTX/XLSX 创建 + `check_office.py` 结构检查 + PDF 转换 + 渲染 + 公式重算（缓存值 5）全过。见 [官方 Office 接线 note](.agents/notes/implemented/architecture/2026-10-03-official-office-and-workspace-dependencies-wiring.md)；**桌面壳启动前自动检测载荷并设 env（目录含 runtime.json 才算），本仓载荷未带 primary-runtime，故开箱桌面显式缺席** |
| 假刹车修复 | edge kill 状态写 0o640（组可读）+ 读取端仅 ENOENT 视为未 kill（EACCES/坏 JSON ⇒ 已 kill 且已暂停）；复现 `pnpm --filter @dshtrading/tradectl exec vitest run test/edge.test.ts test/degradation.test.ts`（38 例，含 chmod 000 端到端）|
| 部署缺口修复 | bot 单元独立 home（StateDirectory=dsh-trading-bot）+ 核心单元显式 `DSH_TRADING_AUTHORITY_DIR`；复现 `node scripts/systemd-units-check.mjs`（全绿）|
| 驾驶舱补完 | 12 封闭卡片类型全渲染（补 mandate/journal/system 三类）、字段排版、卡片动作接线、设备配对 + Bearer 令牌；截图 `.local/acceptance/cockpit-2026-10-02/`（不入库，本机）；复现 `cd packages/cockpit && npx vitest run`（23 例）|
| 两形态对照 | 配了 bot ⇒ 纯客户端：`node desktop/scripts/attach-electron-drill.mjs`（窗口加载远端 bot、本地 host 零命中，2/2）；没配 bot ⇒ 本地 host 保持现状：`node desktop/scripts/attach-drill.mjs`（6/6 含回滚与坏配置）；不混显判据：contract 55 例（source-guard 跨源拒绝）|
| 加密永续与 TradFi 永续（Tier 1，只读） | 形态轴 `form`（spot/perp）契约在 `@dshtrading/api`（唯一判据 `instrumentFormOf` / `SWAP_SYMBOL_SUFFIX`）；Binance/OKX/Bybit 名册汇入永续与 TradFi 元数据、行情按 `-SWAP` 分流（CCXT 显式拒绝）；检索面 `instruments_search type=` 与 `/symbols` wire 透传 form/assetClass。OKX 名册 1644（1144 spot + 500 perp）真实网络复核、`SPX`(迷因币 SPX6900) vs `US500` 反例零错标；**Binance/Bybit 的真值已在可达出口补测转正**（2026-10-08）：Binance 名册 2160（1375 spot + 785 perp）、Bybit 1381（528 + 853），20 条判据全过（见下）。**GUI 形态面（P5）**：左栏/自选管理按形态挂徽标（现货不挂标，现货路径零回归）与 crypto 目标市场的形态过滤（本地字典与上游在线联想都过滤）、添加行随形态与资产类别落库、TradFi 合成合约在图表页有明示位（合成合约 ≠ 股票本身、24/7 报价 vs 股票闭市时段）、种子默认首屏保持 14 行全现货。设计与卡拆分见 docs/roadmap/crypto-perp-and-tradfi.md；GUI 落地判据与边界见 [GUI note](.agents/notes/implemented/feature/2026-10-08-crypto-perp-gui-instrument-form.md) |

## 必须知道的 fail-closed 不变量（改代码前先读）

1. **没有默认授权平面目录**：缺 DSH_TRADING_AUTHORITY_DIR 一律拒绝 ⇒ 实盘恒关（dir-not-configured 是正确的默认）。
2. **授权不可由 agent 自铸**：sign CLI 拒绝当前 uid 作为 agent uid；只有 --force-dev 放行且签出 payload.dev=true，读取端不带同样 opt-in 会拒绝。
3. **额度缺声明即拒绝**（不是"无上限"）；Infinity 明确当"无限"挡掉。
4. **凭据有 seam 即 fail-closed**；demo 与 live 的 key 不通用，demo 组默认 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE。
5. **未知 closed 枚举一律不可操作**（卡片渲染为禁用全部 Action），未知动作在确认闸门按最高档处理。
6. **过期/未知不渲染**；跨源永不混显（数据源会话级单例、每条数据带 sourceId）。
7. **自动路径上 halt 永不可达**（普通故障止于 reduce_only）；halt 只由带外触发。
8. **dry-run 是默认且不可被环境变量悄悄关掉**（desk-process 选项白名单里没有任何键能承载下单能力）。

## 未完成 / 硬停（不要自行推进）

- **第 3 档小额 live**：主网凭证 + **人本人** pnpm authority:sign + 金额上限 + 在环。
- **带外退出演练**：卡片硬要求人在环。
- **推送 main**：需明确授权（本机 main 领先 origin 且从未推送）。
- 已知缺口（见看板卡 cf869789）：~~edge kill 的 fail-open~~（**已修 2026-10-02**）、~~三 uid 下宿主 home 冲突~~（**已修**）、~~三个单元未带 DSH_TRADING_AUTHORITY_DIR~~（**核心单元已带**；人建平面后生效）、~~驾驶舱功能/视觉未打磨~~（**功能补完**：12 类型全渲染 + 配对鉴权；视觉仍骨架级）、~~两形态对照验收未做~~（**已做**，见上表）、L0 下单路径未接线（**结构上尚不存在**：openRiskWithinMandate 与 createRiskGate 的无调用点是当前正确状态，接线点 = 将来的 L0 派发器与 safe boot 生产装配；理由与复现见 docs/ops/ops-runbook.md「接线台账」）、移动端设备项（真机/推送/生物识别，需设备与人）。

- **加密永续真值已复验（可达出口补测，2026-10-08，commit `25d18c7b`）**：本机默认出口（美国节点）仍是 Binance `api.binance.com`/`fapi.binance.com` 全量 451、Bybit `api.bybit.com` 系全量 403（地域拦截）——但同机的 clash 多地域节点（SG/JP/HK/TW/DE/KR/GB）全部可达，换出口后已完成补测：**20 条判据全过、探针退出码 0**（含 `crypto_get_ticker` 底层服务路径的真价）。补测暴露并修好两处真值不符：Binance 原白名单漏掉 **217 行 `TRADIFI_PERPETUAL`**（TradFi 永续整批进不了名册）、Bybit 原把交易所自带的 `symbolType` 分类字段整个丢弃。FX/forex（Binance `USDBRLUSDT-SWAP`、Bybit `EURUSDUSDT-SWAP` 等）无枚举成员故留空——要不要加 `fx` 属 P1 契约决定。原始响应、复现命令与逐条对照见 spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md（卡 `7c7b7e3d`）。
- **合约下单未落地（Tier 2，卡 P7 未开跑）**：Tier 1 是只读面；P7 落地前任何界面与工具描述都不得暗示可下合约单。
- **KDAS 菜单用例的审计债已清零（2026-10-08）**：packages/client-ui-trading/test/kdas-menu.test.ts 的 18 条 bdd 债先按 owner 裁决整文件入基线（`--update --force`），同日按追加要求改成结构合规——标题加角色前缀、正文补 Given/When/Then，断言一条未改（18 条 leaf 原本都有具体期望值，`weak-assert` 全程 0）——再把基线继续下调，该条目已从基线移除（`bdd-title` 1541→1523、`bdd-gwt` 1540→1522）。理由与算术见 [测试卫生棘轮 note](.agents/notes/implemented/testing/2026-09-15-test-hygiene-ratchet-and-tiered-ci.md)。

## 怎么验证（照 AGENTS.md 的资源纪律）

    export npm_config_store_dir=~/Library/pnpm/store/v11     # 本机需要
    pnpm gates:all                                            # 重活：串行跑，期间不要并发跑其它测试
    node scripts/e2e-smoke.mjs [--with-network|--with-electron]
    pnpm wiring:ledger                                        # 工厂接线台账
    node scripts/systemd-units-check.mjs                      # 单元静态校验（退出码即结论）
    cd apps/ios-native && ./scripts/test-contract.sh          # 移动端（原生）：契约防漂移机检
    node scripts/ios-native/check-contract-drift.mjs           # 同上判据的纯 Node 版（CI 用）
    node scripts/ios-native/check-swift-layering.mjs           # Swift 分层白名单（含 Domain 的 Observation 宏）

跑完必查孤儿：ps -eo pid,ppid,command | awk '$2==1' | grep -E "vitest|electron"；验收结论必须绑 HEAD sha 现场复跑。

## 文档地图（一个事实只有一个家）

| 事实 | 家 |
|---|---|
| 项目契约、纪律、硬停 | AGENTS.md |
| 验收状态、未完成项、不变量（本页） | docs/current-state.md |
| 目标架构与 26 条不变量 | docs/design/bot-and-auto-trading.md |
| 运维、kill switch、dead-man、演练记录、接线台账 | docs/ops/ops-runbook.md |
| P5 三档准入与判据、对照基线 | docs/roadmap/p5-acceptance-checklist.md |
| OKX 机制（demo 开关、凭证 ref、权限纪律） | docs/guides/okx-integration.md |
| 移动端（原生观测端）工程形态、构建、冻结契约面与防漂移机检 | apps/ios-native/README.md |
| 移动端落仓方案（含 Expo/RN 退役裁决）与分发决策 | docs/client/mobile-app-plan.md |
| systemd 安装清单 | deploy/README.md |
| 加密永续与 TradFi 永续（形态轴、名册/行情分流、检索面、GUI 形态面） | docs/roadmap/crypto-perp-and-tradfi.md（设计与卡拆分）、docs/guides/symbol-vocabulary.md（词汇权威）、.agents/notes/implemented/feature/2026-10-08-crypto-perp-gui-instrument-form.md（GUI 落地与判据） |
| 历史决策（Owning Note） | .agents/notes/implemented/ |
