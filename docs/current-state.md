# dsh-trading 当前状态（交接事实页）

> 本页是**入库的**交接事实页（不依赖 .local/ 下的本机文件）。只写现在时事实与可复现命令。
> 逐条细节与本机环境见 .local/roadmap/CHECKPOINT.md（gitignored，仅本机可见）与各专题文档。

## 一句话

交易 bot 与 GUI 分离的路线已走到 **P5**：第 1 档 shadow 与**第 2 档 paper（OKX 模拟盘）已通过**；驱动的网页驾驶舱与移动端为**独立产物**；第 3 档小额 live 与带外退出演练**未做**（需人签署 + 在环）。

## 已完成并已验收（可复现）

| 项 | 证据 / 复现 |
|---|---|
| 仓库门禁 | pnpm gates:all ⇒ **16 通过 / 0 失败**（含 build、-r test、覆盖率、typecheck、e2e:smoke 等）|
| P5 第 1 档 shadow | 10 分钟真实行情验收入册（消息 4864 / 坏帧 0 / 全程 aligned / 从未 halt / 退出码 0）；复现 node scripts/e2e-smoke.mjs --with-network |
| **P5 第 2 档 paper（OKX）** | 带真实 demo 凭据：Test Files 8 passed / **Tests 94 passed / 0 skipped**；GET balance 1145ms、GET positions 328ms（均带 x-simulated-trading）。记录见 docs/ops/ops-runbook.md「第 2 档执行记录」|
| 进程装配 | packages/tradectl/src/desk-process.ts：环路 + 事件泵 + **dry-run 派发**（无下单路径）+ 积压告警入审计；演练 drill/desk-process-shadow.ts 退出码即断言 |
| 额度上限 | mandate 侧已成**可执行判据**：缺声明 / Infinity / NaN ⇒ 拒绝开新仓（code=no-declared-limit）；0 是合法声明；只约束新增风险 |
| 凭据语义 | connector-okx：**存在 credentials seam 即 fail-closed**（不再回落 ambient 环境变量）；仅完全无 seam 时回落 process.env |
| 驾驶舱 | packages/cockpit：**独立 SPA**（零依赖、不复用 client-ui-*），由 bot 的 edge 行托管；只调 /v1/cards 与 /v1/commands |
| 移动端 | apps/mobile（独立 npm 工程，不进 pnpm workspace）：契约 ./core 入口 + 配对 + SecureStore + 首屏流程；60 例测试 + Metro 真打包 599 modules |
| systemd 台架 | scripts/systemd-units-check.mjs（六类静态判据，退出码即结论）+ 人执行安装清单（deploy/README.md）。**本机无 systemd，安装未做** |

## 必须知道的 fail-closed 不变量（改代码前先读）

1. **没有默认授权平面目录**：缺 DSH_TRADING_AUTHORITY_DIR 一律拒绝 ⇒ 实盘恒关（dir-not-configured 是正确的默认）。
2. **授权不可由 agent 自铸**：sign CLI 拒绝当前 uid 作为 agent uid；只有 --force-dev 放行且签出 payload.dev=true，读取端不带同样 opt-in 会拒绝。
3. **额度缺声明即拒绝**（不是"无上限"）；Infinity 明确当"无限"挡掉。
4. **凭据有 seam 即 fail-closed**；demo 与 live 的 key 不通用，demo 组默认 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE。
5. **未知 closed 枚举一律不可操作**（卡片渲染为禁用全部 Action），未知动作在确认闸门按最高档处理。
6. **过期/陈旧数据不渲染**；跨源永不混显（数据源会话级单例、每条数据带 sourceId）。
7. **自动路径上 halt 永不可达**（普通故障止于 reduce_only）；halt 只由带外触发。
8. **dry-run 是默认且不可被环境变量悄悄关掉**（desk-process 选项白名单里没有任何键能承载下单能力）。

## 未完成 / 硬停（不要自行推进）

- **第 3 档小额 live**：主网凭证 + **人本人** pnpm authority:sign + 金额上限 + 在环。
- **带外退出演练**：卡片硬要求人在环。
- **推送 main**：需明确授权（本机 main 领先 origin 且从未推送）。
- 已知缺口（见看板卡 cf869789）：**edge kill 的 fail-open（"假刹车"，最高优先）**、三 uid 下宿主 home 冲突、三个单元未带 DSH_TRADING_AUTHORITY_DIR、驾驶舱功能/视觉未打磨、两形态对照验收未做、L0 下单路径未接线。

## 怎么验证（照 AGENTS.md 的资源纪律）

    export npm_config_store_dir=~/Library/pnpm/store/v11     # 本机需要
    pnpm gates:all                                            # 重活：串行跑，期间不要并发跑其它测试
    node scripts/e2e-smoke.mjs [--with-network|--with-electron]
    pnpm wiring:ledger                                        # 工厂接线台账
    node scripts/systemd-units-check.mjs                      # 单元静态校验（退出码即结论）
    cd apps/mobile && npx vitest run && npx tsc --noEmit      # 移动端

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
| 移动端落仓方案与实测 | docs/client/mobile-app-plan.md |
| systemd 安装清单 | deploy/README.md |
| 历史决策（Owning Note） | .agents/notes/implemented/ |
