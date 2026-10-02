# Agent Note: 实盘授权平面（preset 里的 liveTrading 降级为非权威镜像）

Status: implemented

## Problem

红队 RT-04（已复核成立）：实盘闸门的第一段是 `liveTrading` 配置项，而它写在 **agent 可写的文件**里——六个市场的 preset 资产 `.packages/<market>/assets/preset/<market>-trader/agent.cordis.yml`（crypto 五处）与 `.packages/base/src/presets.ts` 的 kit 行。agent 拥有 bash/fs 工具，改一行 YAML 就能把这一段抹掉。

**文件权限不是答案**：设计文档 §2.1 已写死「进程边界在同 uid 下不是安全边界」——今天 agent 与宿主同 uid，把文件挪到别处只是把同一把钥匙换个抽屉。真正的边界是**签名**：agent 能改写文件，但签不出人类私钥的签名。

**2026-10-02 验收发现 #1（本记录的第二次修订）**：签名机制成立，但平面**缺省落在 `$DSH_HOME/authority`**，即 agent 同 uid 可写的位置，且没有任何代码或门禁看它的属主。同 uid 进程可以自己 `init` 一对新密钥、自己写 `trusted-keys.json`、自己 `sign` 一份 grant，然后 `status` 输出「放行（granted）」——「uid 保护」当时只是模块注释里的一句部署前提，而 CHECKPOINT 已把 P0 步骤 3 记为完成。**属主隔离与签名同属这条不变量的边界**：agent 写得进文件，但改不了文件的属主。`packages/authority` 的读取端与运营 CLI 据此重写：默认位置删除、属主/权限/祖先链检查落地、自铸守卫与显式 dev 形态落地、`live-trading-gate` 增加真跑攻击动作的 LG4。

## Decision

新增包 `@dshtrading/authority`（host 平面；运行期入口现在只用 node 内建——平面位置不再从 `$DSH_HOME` 推导，`package.json` 里那条 `@dshtrading/dsh-home` 依赖已无引用，待随下一次 lockfile 变更清理），把实盘许可从配置项改成**人工签署的状态平面**：

- 状态平面目录：**必须显式配置**（显式 `dir` > `$DSH_TRADING_AUTHORITY_DIR`），**没有默认位置**——缺省落在 `$DSH_HOME/authority` 等于把权威放进 agent 自己 uid 可写的目录（验收发现 #1）。未配置一律拒绝，reason = `dir-not-configured`。目录内两份文件：`trusted-keys.json`（受信任公钥，人类写，模块只读）与 `live-trading.grant.json`（人工签署的授权）。
- **平面必须与运行 uid（= agent uid）隔离**（`inspectPlaneIsolation`，随每次判定执行）：从根到平面目录的**整条祖先链**都不得归运行 uid 所有（归它 ⇒ 它可以 unlink 后替换整个平面；对 group/other 可写且无 sticky 位同理），平面目录与两份文件不得归运行 uid 所有、不得带 group/other 写位。任何一条不满足 ⇒ reason = `plane-not-isolated`（机器可读 code 见 `PlaneIsolationCode`，`decision.isolation` 带上完整结论）。可选加固 `$DSH_TRADING_AUTHORITY_OWNER_UID` 把「允许的属主」钉成某个具体 uid；把它配成运行 uid 自身按配置错误拒绝。**这一层是 agent 伪造不了的**：它写得进文件，改不了属主。
- **开发形态必须显式 opt-in 并留痕**：`$DSH_TRADING_AUTHORITY_DEV_SAME_UID=1`（名字里带 dev，值必须精确为 1）跳过隔离检查，但 `decision.devMode=true`、每个平面一次可见告警（`[DEV]`）。dev 形态签出的授权带 **`payload.dev=true`**，而 `payload` 是签名覆盖的规范化字节——抹掉这个标记就是改内容，验签失败；生产读取端（没有同一个 opt-in）拒绝它，reason = `dev-grant-not-accepted`。
- **运营侧（`init`/`sign`）禁止自铸**：写平面的人必须声明 agent 跑在哪个 uid 下（`--agent-uid` / `$DSH_TRADING_AUTHORITY_AGENT_UID`）；声明不了 ⇒ `agent-uid-required`，声明成当前 uid（自铸形态）⇒ `agent-uid-equals-operator`，除非显式 `--force-dev`（此时授权带 dev 标记）。`init` 拒绝覆盖已存在的 `trusted-keys.json`（`trust-anchor-exists`，除 `--force-dev`）；`sign` 要求平面目录已存在（`plane-dir-missing`）、信任锚已存在（`trust-anchor-missing`）、且私钥的公钥半边确实登记在锚里（`key-not-trusted`）。
- 授权文档：`{ protocolVersion, payload, signature }`，Ed25519 签名覆盖 **`canonicalize(payload)`**（键递归排序、无空白）而不是文件字节——换格式化工具不会让有效授权失效，重排键序也不会变成一次静默篡改。`payload` 必须含 `liveTrading: true` / `issuedAt` / `expiresAt`（到期必填，设计文档 §12.3：续签 = 重新签名）。
- **fail-closed**：缺失 / 读不到 / JSON 坏 / protocolVersion 不符 / 密钥不在信任表 / 验签失败 / 未生效 / 过期，一律 `reason` 拒绝，绝不因为读不到而放行。撤销 = 删掉授权文档；缓存按文件 stat 指纹失效（不是 TTL），下一次判定即生效，不需要重启。
- **判定取合取（只收紧）**：`liveTradingEnabled(mirror) = mirror === true && 平面已授予`。preset 资产里的 `liveTrading` 降级为**非权威镜像**：写 false 仍然是否决（有效的收紧手段），写 true 什么都不授予——只会产生一次可见告警（`process.emitWarning`，code `DSH_TRADING_LIVE_AUTHORITY_MISMATCH`），因为「镜像与平面不一致」本身就是需要人看见的事件。
- 全部连接器的判定点改为经 `liveTradingEnabled`（含 `.ts 模板`——新连接器生成即合规）：本次实测 18 个包的 `src` 共 39 处调用点（`grep -rn "liveTradingEnabled(" packages/*/src | grep -v authority | wc -l`），19 个包的 `package.json` 声明 `@dshtrading/authority` 依赖。
- 签署侧单独入口 `@dshtrading/authority/sign`（运营守卫 `resolveOperatorIdentity` / `initTrustAnchor` / `signGrantIntoPlane` + 测试夹具 `/testing`）+ 运营 CLI `.packages/authority/bin/sign-live-trading.mjs`（`init` / `sign` / `status`；`init`/`sign` 必须显式给出 `--dir`，`status` 可用 `--agent-uid` 以读取端视角预演判定）。
- 测试夹具分两形态：`installTestAuthority()`（缺省）= 显式 dev 形态（同 uid 平面 + dev opt-in + `payload.dev=true`，连接器用例走这条，每次判定留痕）；`installTestAuthority({ dev: false })` = 生产形态（不带 dev 标记；用 `fixture.authorityOptions` 注入 euid 表达「平面归另一个 uid」，本机同 uid 造不出真实属主差异）。**运行期不得 import 签署侧**——「谁能签发」由模块图保证，不靠运行期纪律；`pnpm live-trading:check` 的 LG3 把这条钉死。
- **对外 API 里永远不存在「打开实盘」这个端点**（设计文档 §5）：授权的唯一入口是本机 CLI + 人类私钥。

新增 `.scripts/live-trading-gate.mjs`（`pnpm live-trading:check`，CI static-gates）：LG1 镜像只许 false；LG2 源码里不得出现裸 `!config.liveTrading` 判定；LG3 运行期源码不得引用 `/sign` 或 `/testing`；**LG4（验收发现 #1 之后新增，行为规则）**：断言平面必须显式配置（未配置解析不出任何目录、判定是 `dir-not-configured`）、dev opt-in 名字里必须带 dev，并且**门禁自己真造一份自铸平面**（真实 Ed25519 密钥 + 真实 `trusted-keys.json` + 真实签名授权）断言读取端仍拒绝（`plane-not-isolated`）、只有显式 dev opt-in 才放行。门禁自测用契约替身注入旧语义，证明 LG4 不是恒真。

## Evidence

CLI 端到端（临时目录）：无授权 → `拒绝（no-grant-document）`；`sign` 后 → `放行（granted）`；把 `payload.expiresAt` 改成 2099 → `拒绝（bad-signature）`。

**验收发现 #1 之后的实测（2026-10-02，本机 uid 501）**：

- 复现序列不再放行：`init`（无 flag）→ exit 1 `agent-uid-required`；`sign` → exit 1 同码；`status` → 拒绝（`no-trusted-keys`），平面目录根本没被创建。
- 攻击者强行 `--force-dev` 自铸：`init`/`sign` 成功但各留一行 `[authority][DEV]`；`status`（读取端无 opt-in）→ `拒绝（plane-not-isolated）`，隔离结论 `ancestor-agent-writable`——祖先目录归运行 uid 所有；同一平面加 `DSH_TRADING_AUTHORITY_DEV_SAME_UID=1` → `放行（granted）` + dev 留痕。
- 合法路径（人 uid 501 为声明的 agent uid 999999 建平面）：`init --agent-uid 999999` → `运行 uid 501 ≠ 声明的 agent uid 999999`；`sign` → 复验 `granted`；`status --agent-uid 999999` → `平面隔离：isolated` + `放行（granted）`；不给 `--agent-uid` 时同一平面仍拒绝——因为本机 uid 自己就是平面属主，这正是同 uid 的诚实结论。
- 用例：`packages/authority` 42 例全绿（原 18 + 新增 24：隔离 11 / 运营守卫 10 / CLI 端到端 3）；`pnpm test:audit` 无新增测试债；`scripts/live-trading-gate.test.mjs` 12 例全绿（LG4 四条：真实源码能绿 + 旧语义默认位置、自铸判放行、dev 名字不含 dev 三种能红）。
- 门禁现状：`[live-trading-gate] ✓ 7 个镜像文件全部只写 false；330 个运行期源文件无裸判定、无签署侧引用；授权平面必须显式配置、自铸平面被拒（LG4 实跑探针）。`
- 依赖方回归：三个连接器用例套件（tiger 6 / binance 10 / okx 34）在夹具换成显式 dev 形态后仍全绿。

篡改 preset 资产不改变实盘权限（`.packages/authority/test/live-trading-authority.test.ts`）：读真实资产 → 把 `liveTrading: false` 全替换成 true → 解析出镜像确实是 true → 判定仍 `allowed: false`（`no-trusted-keys` / `no-grant-document`），且 `mismatch: true`、告警真的发出。连接器层同样有一例回归：`.packages/connector-binance/test/place-order.test.ts` 里「preset 资产被改成 liveTrading=true 但平面未授予 → 仍结构化拒绝」。

## Alternatives considered

- **把 liveTrading 从配置里删掉、只留平面**：能表达「平面是唯一授予者」，但会抹掉「部署方想硬性否决」这条有效能力，且现网所有 profile 都得同批改。保留为只能收紧的镜像成本更低、语义更强。败。
- **靠文件权限（0700 目录、uid 隔离）**：§2.1 已裁决同 uid 下不是边界；uid 分离是 P2 的部署属性，不能替代签名。败——但**反过来同样成立**（验收发现 #1 的教训）：签名也不能替代属主隔离。签名回答「谁签的」，属主回答「平面归谁」；只有签名时，agent 自己签一份给自己就是了。两者都要，缺一不可（读取端的 `inspectPlaneIsolation` 因此不是可选的加固）。
- **保留 `$DSH_HOME/authority` 默认位置、只加属主校验**：平面缺省位置的每一层祖先（`$DSH_HOME` 本身、用户的 home）都归 agent uid，agent 可以 unlink 后重建一个自己的同名目录 —— 一个「默认落在 agent 可写树里」的路径无论自己多干净都不可隔离。败（因此删除默认位置：未配置 ⇒ 拒绝，而不是「落在 home 里再校验」）。
- **只靠运营侧守卫挡自铸**：CLI 守卫（`--agent-uid` / 拒绝覆盖信任锚）是纵深防御，不是边界 —— agent 有 bash/fs，可以直接写 JSON，也可以 import 签署侧模块自签。执行点必须在**读取端**（属主检查是 agent 改不了的那一项），CLI 守卫只负责让「人」在做对的事时不至于做错。败（作为唯一防线）。
- **dev 形态只打告警、不标记授权**：告警看完就没了；把 `dev: true` 放进**签名覆盖的 payload**，dev 授权才搬不进生产面（抹标记 = 改内容 = 验签失败）。败。
- **读取端用「声明的 agent uid」环境变量代替 euid**：agent 与判定进程同 uid 时它能影响环境，而文件属主是内核记账、改不了。euid 是唯一不可伪造的输入。败。
- **用 `approval/request` 承载实盘授权**：该缝要求 open turn、派发不带工具参数、唯一授予词是一次性的 `allowed-once`，语义不足以承载一份带范围的授权。它只做人工升级适配器。败。
- **把平面放在仓库内（如 `.local/authority/`）**：仓库就是 agent 的工作目录，等于没搬。败。
- **到期不设或后端兜底续签**：静默延期把「人重新确认」这件事吃掉。到期即降级，续签 = 重新签名。败。
- **读不到平面时按「未配置 = 沿用旧行为」**：这正是 RT-04 的形态。fail-closed 是唯一可接受语义。败。

## Consequences

- 今天起，任何实盘执行都需要**人在本机**签署一份带到期的授权；未签署时所有连接器的实盘路径结构化拒绝（错误码 `TRADING_LIVE_TRADING_DISABLED` 不变，文案改为指向授权平面）。
- 签署私钥必须由人在**另一个 uid** 下持有（0600）；同 uid 下本模块挡得住「改资产」与「用自己 uid 自铸平面」，挡不住「拿到私钥或拿到 root」——这条诚实边界写进 `.packages/authority/src/index.ts` 的头注。
- 未验证项一（更新）：**本机同 uid 下，「uid 保护」由读取端的属主检查执行**——同 uid 自铸的平面一律 `plane-not-isolated`，开发形态必须显式 opt-in 且带 dev 标记。**仍未验证的是部署属性**：真实的两个 uid 分离（人 / agent 各一个 principal）需要 P2/P5 的部署验收，本机单用户环境无法证明隔离强度，也不能替生产签字。
- 未验证项二：真实的「人签署 → 实盘放行」全链路要等 P2 的执行核与 P5 的小额 live 验收；今天连接器侧的 live 分支多数仍抛 `TRADING_NOT_IMPLEMENTED`。
- 相关取代关系：[实盘安全闸门双轨制](2026-08-29-dual-track-trading-gate.md) 与 [服务缝闸门](../feature/2026-09-01-service-seam-order-gate.md) 的三态语义与枚举不变，本记录只改**第一段闸门的权威来源**（配置项 → 人工签署平面）；那两篇已在原地补充指针。
