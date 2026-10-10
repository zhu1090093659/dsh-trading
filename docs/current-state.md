# dsh-trading 当前状态（交接事实页）

> 本页是**入库的**交接事实页（不依赖 .local/ 下的本机文件）。只写现在时事实与可复现命令。
> 逐条细节与本机环境见 .local/roadmap/CHECKPOINT.md（gitignored，仅本机可见）与各专题文档。

## 一句话

交易 bot 与 GUI 分离的路线已走到 **P5**：第 1 档 shadow 与**第 2 档 paper（OKX 模拟盘）已通过**；自动交易实现（bot/tradectl/cockpit/contract、iOS 观测端、deploy 单元）已于 2026-10-03 迁往私有卫星仓 dsh-trading-bot，主仓只保留接缝（packages/authority 实盘闸门 + packages/bot-api 公开 GUI 行情桥）；第 3 档小额 live 与带外退出演练**未做**（需人签署 + 在环）。

## 已完成并已验收（可复现）

| 项 | 证据 / 复现 |
|---|---|
| 仓库门禁 | pnpm gates:all ⇒ **14 通过 / 0 失败**（2026-10-10 现场复跑，HEAD `506c47d6`，其后仅 docs 提交；14 条：build、-r test、test:audit、test:scripts、test:desktop、覆盖率、patch-id、live-trading、i18n、home-guard、typecheck、repo-boundary、ci-wiring、docs-link）|
| 自动交易平面（shadow/paper 验收、进程装配、mandate 额度判据、驾驶舱、iOS 观测端、systemd 单元与部署缺口） | **已迁往私有卫星仓 [dsh-trading-bot](https://github.com/zhu1090093659/dsh-trading-bot)**（2026-10-03 拆分）：实现、演练、runbook、部署清单与验收记录都在那边；主仓只保留接缝——packages/authority（实盘闸门）与 packages/bot-api（公开 GUI 行情桥）。切分裁决与边界见 [卫星仓切分 note](.agents/notes/implemented/architecture/2026-10-03-auto-trading-plane-private-satellite-split.md) |
| 凭据语义 | connector-okx：**存在 credentials seam 即 fail-closed**（不再回落 ambient 环境变量）；仅完全无 seam 时回落 process.env |
| 官方 Office 技能与依赖加载 | base 层两条官方行（id `skill-office` / `workspace-dependencies`，`DSH_PRIMARY_RUNTIME` 门控，无载荷显式缺席）。真实会话实测 catalog/provider/resourceBase、加载期注入的 LibreOffice Kit 段、`load_workspace_dependencies` 可见；DOCX/PPTX/XLSX 创建 + `check_office.py` 结构检查 + PDF 转换 + 渲染 + 公式重算（缓存值 5）全过。见 [官方 Office 接线 note](.agents/notes/implemented/architecture/2026-10-03-official-office-and-workspace-dependencies-wiring.md)；**桌面壳启动前自动检测载荷并设 env（目录含 runtime.json 才算），本仓载荷未带 primary-runtime，故开箱桌面显式缺席** |
| 桌面壳附着模式（已退役） | 2026-10-07 owner 裁决移除：机器人观测与控制收拢到交易终端内的 @dshtrading/client-ui-bot-gui 插件，桌面壳回归单一本地终端形态；attach-mode/设备凭据模块与两条演练脚本（attach-drill / attach-electron-drill）已删。裁决与替代方案见 [electron desktop note](.agents/notes/implemented/architecture/2026-09-03-electron-desktop-app.md) |
| 加密永续与 TradFi 永续（Tier 1，只读） | 形态轴 `form`（spot/perp）契约在 `@dshtrading/api`（唯一判据 `instrumentFormOf` / `SWAP_SYMBOL_SUFFIX`）；Binance/OKX/Bybit 名册汇入永续与 TradFi 元数据、行情按 `-SWAP` 分流（CCXT 显式拒绝）；检索面 `instruments_search type=` 与 `/symbols` wire 透传 form/assetClass。OKX 名册 1644（1144 spot + 500 perp）真实网络复核、`SPX`(迷因币 SPX6900) vs `US500` 反例零错标；**Binance/Bybit 的真值已在可达出口补测转正**（2026-10-08）：Binance 名册 2160（1375 spot + 785 perp）、Bybit 1381（528 + 853），20 条判据全过（见下）。**GUI 形态面（P5）**：左栏/自选管理按形态挂徽标（现货不挂标，现货路径零回归）与 crypto 目标市场的形态过滤（本地字典与上游在线联想都过滤）、添加行随形态与资产类别落库、TradFi 合成合约在图表页有明示位（合成合约 ≠ 股票本身、24/7 报价 vs 股票闭市时段）、种子默认首屏保持 14 行全现货。设计与卡拆分见 docs/roadmap/crypto-perp-and-tradfi.md；GUI 落地判据与边界见 [GUI note](.agents/notes/implemented/feature/2026-10-08-crypto-perp-gui-instrument-form.md)（验收证据 `.local/acceptance/crypto-perp-gui-2026-10-08/`，本机不入库）|
| 合约交易语义与闸门（Tier 2，P7） | OKX：合约下单（张↔币按 ctVal **向下**取整）、杠杆/保证金模式 `crypto_set_leverage`（与下单同门槛）、持仓强平/保证金字段；Binance：`-SWAP` 下单显式 `TRADING_UNSUPPORTED_SYMBOL`。判据：`pnpm --filter @dshtrading/connector-okx test`（test/contract-trading.test.ts：换算向量/闸门矩阵/tdMode 分流/持仓字段）、`pnpm --filter @dshtrading/base test`（test/live-action-gate.test.ts）、`pnpm --filter @dshtrading/connector-binance test`。机制见 [OKX 集成 §9](docs/guides/okx-integration.md) 与 [服务缝闸门 note](.agents/notes/implemented/feature/2026-09-01-service-seam-order-gate.md) |

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
- 已知缺口（见看板卡 cf869789）：~~edge kill 的 fail-open~~（**已修 2026-10-02**，代码在卫星仓）、~~三 uid 下宿主 home 冲突~~（**已修**）、~~三个单元未带 DSH_TRADING_AUTHORITY_DIR~~（**核心单元已带**；人建平面后生效）、~~驾驶舱功能/视觉未打磨~~（**功能补完**：12 类型全渲染 + 配对鉴权；视觉仍骨架级）、~~两形态对照验收未做~~（**已做**：附着形态本身于 2026-10-07 退役）、L0 下单路径未接线（**结构上尚不存在**：openRiskWithinMandate 与 createRiskGate 已随平面迁往卫星仓，主仓没有可接线对象）、移动端设备项（真机/推送/生物识别，需设备与人；工程在卫星仓）。

- **加密永续真值已复验（可达出口补测，2026-10-08，commit `25d18c7b`）**：本机默认出口（美国节点）仍是 Binance `api.binance.com`/`fapi.binance.com` 全量 451、Bybit `api.bybit.com` 系全量 403（地域拦截）——但同机的 clash 多地域节点（SG/JP/HK/TW/DE/KR/GB）全部可达，换出口后已完成补测：**20 条判据全过、探针退出码 0**（含 `crypto_get_ticker` 底层服务路径的真价）。补测暴露并修好两处真值不符：Binance 原白名单漏掉 **217 行 `TRADIFI_PERPETUAL`**（TradFi 永续整批进不了名册）、Bybit 原把交易所自带的 `symbolType` 分类字段整个丢弃。FX/forex（Binance `USDBRLUSDT-SWAP`、Bybit `EURUSDUSDT-SWAP` 等）无枚举成员故留空——要不要加 `fx` 属 P1 契约决定。原始响应、复现命令与逐条对照见 spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md（卡 `7c7b7e3d`）。
- **合约交易已接线（Tier 2，卡 P7，2026-10-08）**：OKX 路由下合约可下单——`quantity` 恒为 base 币数、连接器按 ctVal 折算张数并按 lotSz 向下取整；杠杆/保证金模式走 `crypto_set_leverage`（与下单共用同一套三态闸门 + base 的 `LIVE_ACTION_GATE_PATTERN` 审批，headless ask=deny）；持仓回带强平价/维持保证金率/保证金模式/名义价值（交易所口径，缺席不本地补算）。**dry-run 仍是缺省**，实盘仍需人工签署授权 + 审批（`env=demo` 打模拟盘，`env=live` 才是真钱）。Binance 路由下合约**只有行情**：`-SWAP` 下单显式报 `TRADING_UNSUPPORTED_SYMBOL`，绝不回落现货端点。**未接线（在卫星仓）**：额度/mandate 的合约口径判定（现货口径 `leverage=1` 永不命中）属私有卫星仓 `dsh-trading-bot` 的 tradectl。
- **KDAS 菜单用例的审计债已清零（2026-10-08）**：packages/client-ui-trading/test/kdas-menu.test.ts 的 18 条 bdd 债先按 owner 裁决整文件入基线（`--update --force`），同日按追加要求改成结构合规——标题加角色前缀、正文补 Given/When/Then，断言一条未改（18 条 leaf 原本都有具体期望值，`weak-assert` 全程 0）——再把基线继续下调，该条目已从基线移除（`bdd-title` 1541→1523、`bdd-gwt` 1540→1522）。理由与算术见 [测试卫生棘轮 note](.agents/notes/implemented/testing/2026-09-15-test-hygiene-ratchet-and-tiered-ci.md)。

## 怎么验证（照 AGENTS.md 的资源纪律）

    export npm_config_store_dir=~/Library/pnpm/store/v11     # 本机需要
    pnpm gates:all                                            # 重活：串行跑，期间不要并发跑其它测试

自动交易平面（bot/tradectl/cockpit/contract、iOS 观测端、deploy 单元）的演练、单元静态校验与移动端机检随实现迁往私有卫星仓 dsh-trading-bot，入口见该仓 README；主仓不再有 e2e-smoke / wiring:ledger / systemd-units-check 与 apps/ios-native 脚本。

跑完必查孤儿：ps -eo pid,ppid,command | awk '$2==1' | grep -E "vitest|electron"；验收结论必须绑 HEAD sha 现场复跑。

## 文档地图（一个事实只有一个家）

| 事实 | 家 |
|---|---|
| 项目契约、纪律、硬停 | AGENTS.md |
| 验收状态、未完成项、不变量（本页） | docs/current-state.md |
| 目标架构与 26 条不变量 | docs/design/bot-and-auto-trading.md |
| 运维、kill switch、dead-man、演练记录、接线台账（随平面迁走） | 卫星仓 [dsh-trading-bot](https://github.com/zhu1090093659/dsh-trading-bot) 的 docs/ops/ops-runbook.md |
| P5 三档准入与判据、对照基线 | docs/roadmap/p5-acceptance-checklist.md |
| OKX 机制（demo 开关、凭证 ref、权限纪律） | docs/guides/okx-integration.md |
| 移动端（原生观测端）工程形态、构建、冻结契约面与防漂移机检 | 卫星仓 dsh-trading-bot 的 apps/ios-native |
| 移动端落仓方案（含 Expo/RN 退役裁决）与分发决策 | 卫星仓 dsh-trading-bot 的 docs/client/mobile-app-plan.md |
| systemd 安装清单 | 卫星仓 dsh-trading-bot 的 deploy/README.md |
| 加密永续与 TradFi 永续（形态轴、名册/行情分流、检索面、GUI 形态面） | docs/roadmap/crypto-perp-and-tradfi.md（设计与卡拆分）、docs/guides/symbol-vocabulary.md（词汇权威）、.agents/notes/implemented/feature/2026-10-08-crypto-perp-gui-instrument-form.md（GUI 落地与判据） |
| 历史决策（Owning Note） | .agents/notes/implemented/ |
