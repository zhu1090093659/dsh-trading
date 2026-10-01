# Agent Note: 实盘授权平面（preset 里的 liveTrading 降级为非权威镜像）

Status: implemented

## Problem

红队 RT-04（已复核成立）：实盘闸门的第一段是 `liveTrading` 配置项，而它写在 **agent 可写的文件**里——六个市场的 preset 资产 `.packages/<market>/assets/preset/<market>-trader/agent.cordis.yml`（crypto 五处）与 `.packages/base/src/presets.ts` 的 kit 行。agent 拥有 bash/fs 工具，改一行 YAML 就能把这一段抹掉。

**文件权限不是答案**：设计文档 §2.1 已写死「进程边界在同 uid 下不是安全边界」——今天 agent 与宿主同 uid，把文件挪到别处只是把同一把钥匙换个抽屉。真正的边界是**签名**：agent 能改写文件，但签不出人类私钥的签名。

## Decision

新增包 `@dshtrading/authority`（host 平面，零运行期依赖除 `@dshtrading/dsh-home`），把实盘许可从配置项改成**人工签署的状态平面**：

- 状态平面目录：显式 `dir` > `$DSH_TRADING_AUTHORITY_DIR` > **`$DSH_HOME/authority/`**。它不在仓库工作区里，也不在安装态 profile 的 preset 资产里——这是「实盘开关不在 agent 可写路径上」的物理前提。目录内两份文件：`trusted-keys.json`（受信任公钥，人类写，模块只读）与 `live-trading.grant.json`（人工签署的授权）。
- 授权文档：`{ protocolVersion, payload, signature }`，Ed25519 签名覆盖 **`canonicalize(payload)`**（键递归排序、无空白）而不是文件字节——换格式化工具不会让有效授权失效，重排键序也不会变成一次静默篡改。`payload` 必须含 `liveTrading: true` / `issuedAt` / `expiresAt`（到期必填，设计文档 §12.3：续签 = 重新签名）。
- **fail-closed**：缺失 / 读不到 / JSON 坏 / protocolVersion 不符 / 密钥不在信任表 / 验签失败 / 未生效 / 过期，一律 `reason` 拒绝，绝不因为读不到而放行。撤销 = 删掉授权文档；缓存按文件 stat 指纹失效（不是 TTL），下一次判定即生效，不需要重启。
- **判定取合取（只收紧）**：`liveTradingEnabled(mirror) = mirror === true && 平面已授予`。preset 资产里的 `liveTrading` 降级为**非权威镜像**：写 false 仍然是否决（有效的收紧手段），写 true 什么都不授予——只会产生一次可见告警（`process.emitWarning`，code `DSH_TRADING_LIVE_AUTHORITY_MISMATCH`），因为「镜像与平面不一致」本身就是需要人看见的事件。
- 全部 18 个连接器的 43 处判定点改为经 `liveTradingEnabled`（含 `.ts 模板`——新连接器生成即合规）；12 个包的 `package.json` 增加 `@dshtrading/authority` 依赖。
- 签署侧单独入口 `@dshtrading/authority/sign`（+ 测试夹具 `/testing`）+ 运营 CLI `.packages/authority/bin/sign-live-trading.mjs`（`init` / `sign` / `status`）。**运行期不得 import 签署侧**——「谁能签发」由模块图保证，不靠运行期纪律；`pnpm live-trading:check` 的 LG3 把这条钉死。
- **对外 API 里永远不存在「打开实盘」这个端点**（设计文档 §5）：授权的唯一入口是本机 CLI + 人类私钥。

新增 `.scripts/live-trading-gate.mjs`（`pnpm live-trading:check`，CI static-gates）：LG1 镜像只许 false；LG2 源码里不得出现裸 `!config.liveTrading` 判定；LG3 运行期源码不得引用 `/sign` 或 `/testing`。

## Evidence

CLI 端到端（临时目录）：无授权 → `拒绝（no-grant-document）`；`sign` 后 → `放行（granted）`；把 `payload.expiresAt` 改成 2099 → `拒绝（bad-signature）`。

篡改 preset 资产不改变实盘权限（`.packages/authority/test/live-trading-authority.test.ts`）：读真实资产 → 把 `liveTrading: false` 全替换成 true → 解析出镜像确实是 true → 判定仍 `allowed: false`（`no-trusted-keys` / `no-grant-document`），且 `mismatch: true`、告警真的发出。连接器层同样有一例回归：`.packages/connector-binance/test/place-order.test.ts` 里「preset 资产被改成 liveTrading=true 但平面未授予 → 仍结构化拒绝」。

门禁现状：`[live-trading-gate] ✓ 7 个镜像文件全部只写 false；280 个运行期源文件无裸判定、无签署侧引用。`（门禁自测 8 例在 `pnpm test:scripts` 内。）

## Alternatives considered

- **把 liveTrading 从配置里删掉、只留平面**：能表达「平面是唯一授予者」，但会抹掉「部署方想硬性否决」这条有效能力，且现网所有 profile 都得同批改。保留为只能收紧的镜像成本更低、语义更强。败。
- **靠文件权限（0700 目录、uid 隔离）**：§2.1 已裁决同 uid 下不是边界；uid 分离是 P2 的部署属性，不能替代签名——而且它今天不成立。败（uid 分离仍要做，但它是「谁能读到私钥」的问题，不是「谁能授予」的问题）。
- **用 `approval/request` 承载实盘授权**：该缝要求 open turn、派发不带工具参数、唯一授予词是一次性的 `allowed-once`，语义不足以承载一份带范围的授权。它只做人工升级适配器。败。
- **把平面放在仓库内（如 `.local/authority/`）**：仓库就是 agent 的工作目录，等于没搬。败。
- **到期不设或后端兜底续签**：静默延期把「人重新确认」这件事吃掉。到期即降级，续签 = 重新签名。败。
- **读不到平面时按「未配置 = 沿用旧行为」**：这正是 RT-04 的形态。fail-closed 是唯一可接受语义。败。

## Consequences

- 今天起，任何实盘执行都需要**人在本机**签署一份带到期的授权；未签署时所有连接器的实盘路径结构化拒绝（错误码 `TRADING_LIVE_TRADING_DISABLED` 不变，文案改为指向授权平面）。
- 签署私钥与 `trusted-keys.json` 必须由人在**另一个 uid** 下持有/写入；同 uid 下本模块挡得住「改资产」，挡不住「拿到私钥」——这条诚实边界写进了 `.packages/authority/src/index.ts` 的头注，并在 P2 把平面目录交给执行核 `tradectl` 时变成真实隔离。
- 未验证项一：**P2 之前，平面目录与 agent 同 uid**，因此「uid 保护」尚未成立；本变更交付的是**代码路径、路径模型与 fail-closed 语义**与生产一致（§2.1 允许的开发形态），不是它的隔离强度。
- 未验证项二：真实的「人签署 → 实盘放行」全链路要等 P2 的执行核与 P5 的小额 live 验收；今天连接器侧的 live 分支多数仍抛 `TRADING_NOT_IMPLEMENTED`。
- 相关取代关系：[实盘安全闸门双轨制](2026-08-29-dual-track-trading-gate.md) 与 [服务缝闸门](../feature/2026-09-01-service-seam-order-gate.md) 的三态语义与枚举不变，本记录只改**第一段闸门的权威来源**（配置项 → 人工签署平面）；那两篇已在原地补充指针。
