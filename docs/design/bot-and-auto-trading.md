# Trading Bot 与 GUI 分离、Auto Trading 目标架构

状态：**提案（未实现）**。决策记录见 [.agents/notes/proposed/architecture/2026-10-01-bot-gui-split-and-auto-trading.md](../../.agents/notes/proposed/architecture/2026-10-01-bot-gui-split-and-auto-trading.md)。
本文件是本次架构讨论的**唯一事实之家**：四份工作稿（进程与基础设施 / Agent 决策循环与授权 / 对外契约与客户端 / 兼容性与红队）的结论在此收敛，工作稿本身是过程材料，不作长期引用。

---

## 0. 产品形态（用户已拍板）

- 项目分为 **Trading Bot**（可跑在无图形界面的 Linux 服务器上）与 **GUI**。
- Bot 两种模式：**辅助交易**（现状：分析、记录、人工确认下单）与 **Auto Trading**（决策完全由 Agent 自主，首次完全授权后全自动）。
- 执行侧"配备不同的 API"：多交易所 / 多券商 / 多执行通路，**首发加密**，其余市场预留扩展接口。
- GUI：**网页驾驶舱** + **单独的原生移动 App**（内部分发；只做观测与发指令，**不做手动下单面板**）。
- 产品叙事变更：README 现口径"不是无人值守的实盘交易机器人"必须改写为"可控自主的交易 Agent（辅助 + 自动双模）"。

---

## 1. 三条架构公理

1. **权威态在执行核，GUI 只是视图。** 行情缓存、desk 状态、持仓、订单状态机、授权（mandate）、审计全部归执行核；任何客户端崩溃/断线不得影响执行。
2. **快慢双环。** 快环 = 行情归一 → 风控判定 → 订单状态机，确定性、毫秒级、**永不经过 LLM 与浏览器**；慢环 = Agent 决策会话，秒到分钟级。
3. **授权从"每单点击"升级为"人签一份授权合约"。** 闸门不删除：辅助模式下应答者是人，Auto 模式下应答者是 mandate（越界升级到人），任何情况下都不存在"无人把守"的执行路径。

---

## 2. 进程与部署模型

### 2.1 三个进程（生产环境三个 OS principal）

| 进程 | 职责 | 凭据 | 网络暴露 |
|---|---|---|---|
| `tradectl`（执行核） | 行情归一、风控/mandate 判定、订单状态机、对账、审计账本、快环看门狗 | **唯一持有交易凭据** | **只监听 Unix domain socket，不监听任何网络接口** |
| `dsh(trading-bot)`（Agent 宿主） | 会话、技能、工具、研究、慢环决策、触发器产出 | 仅 LLM / 数据源凭据 | 无监听 |
| `edge`（对外网关） | 网页/移动端 API、推送、设备鉴权、静态资源 | 无 | **唯一对网络暴露的进程** |

三者通过 **UDS + 长度前缀 JSON** 互联（协议带 `protocolVersion` 逐帧校验；socket 文件 0660 + 属主校验 + `SO_PEERCRED` 双保险 + 周期 `lstat` 校验 inode 防顶替）。
**socket 权限的正确组合**：socket 所在**目录归 `tradectl`、权限 0750（组可进入、不可写）**，socket 文件 0660 + 属主校验。只把文件设成 0660 而目录对组可写是不够的——组内任意进程可 unlink 后重绑 socket ⇒ 整条主循环被 MITM。
**调用方认证的主机制是继承 fd**（实测：纯 Node 的 UDS server 侧没有 `getPeerCredentials()`，`SO_PEERCRED` 需要原生扩展，因此不以它为主机制）；周期 `lstat` 校验 inode 防顶替（**inode 校验失败 ⇒ 立即 freeze-risk 且不自动重绑**，否则攻击者换完再换回，只多一个告警）——但没有目录权限断言时，它只是多一个告警。**这是当前方案唯一未闭合的实现缺口**（若要 uid 校验须引原生扩展，DSH 树内的 `node-addon-system-*` 可作参考）。

**性能代价实测**：UDS 往返 p50 13µs / p99 85µs，占端到端 p99 的约 0.085%——这条边界不付延迟代价。

**诚实边界**：进程边界在**同 uid 下不是安全边界**（agent 的 bash 能 `cat` 凭据）。安全隔离只在 UID 分离时成立。生产必须分离；开发/单机允许退化为同 uid 两进程，但**代码路径、socket 权限模型、凭据加载位置必须与生产一致**。

### 2.2 Bot 是一个 dsh surface，不是自建程序

- bot = 新增 **profile `trading-bot`**（`$DSH_HOME/profiles/trading-bot`）= `@deepseek-ai/dsh-base` + 自建 `@dshtrading/bot` bundle + 自有 `bot-startup` provider 行 + 自有传输行；**不含** `webserver` / `connection` / `modules` 行。
- 依据：官方 `dsh-app-boot` README「Product applications use the `dsh` launcher instead of publishing separate bins」「Product features belong in profile bundles instead of new application bins」；新 surface 的范式可直接照抄 `dsh-web-app` 的 `web-startup` provider（README 自陈"no launcher metadata or special row kind is needed"）。
- 由此继承 launcher 的 profile 解析、peer 版本校验、必需项审计与失败诊断，**不自养一套组合器**。
- **不踩 web 栈**：`connection` 的信任栅栏是浏览器语义（tokenized URL + 签名 cookie + Host/Origin 校验），移动端需要设备令牌；且全局必需项（`agent-loop, webserver, modules, connection, headless-runner, acp, sdk-jsonrpc-server`）在场且失败会让整个 app dispose 退出。官方 Typert Remote 绑定只作为 **GUI profile 的可选绑定**。

### 2.3 不在架构里的东西

Rust/Go 侧车（判据未触发，见 §3）、Postgres / NATS / Redis、自建 application bin、把 Web 宿主当 bot 宿主。

---

## 3. 热路径语言与性能判据

**结论：TypeScript/Node 足够。** 实测单 tick 全路径（解码 → 归一 → 风控 → 状态机跃迁）0.865–1.208µs；本进程内全部开销（含 UDS IPC）p99 ≈ 0.35ms，而交易所往返 p99 是 100–300ms 量级 ⇒ 进程内优化收益上限约 0.35%。

**真正的瓶颈是行情面**：全部 23 个连接器的 `subscribeTicker` 都是 REST 轮询，全仓 WebSocket 零命中。因此**新增 crypto WS 行情适配（Binance / OKX / Bybit 先行）是独立工作项**，并与 `tradingMarketDataRegistry` / `tradingMarketRouter` 契约并存（能力声明 snapshot-only vs streaming；断线重连走"gap → 重新快照"）。

**对称的两条纪律**：客户端「观测面不依赖 tick 流」（§7.4）+ 服务端「风控不把 tick 流当唯一真相」= 一句话：**tick 流是优化，快照是契约**。因此新增 WS 适配的边界是：只做真有推送面的市场（crypto 先行），**不做股票市场的"伪 WS"**（把轮询搬到服务端并不降低信息延迟，只多一层可失败组件）；能力用可选 `capabilities()` 声明（`ticker: snapshot-only | streaming`、`maxSnapshotAgeMs` 等），**缺席时保守按 snapshot-only 处理 ⇒ 23 个既有连接器零改动**。断线重连的铁律：**先缓冲后发布**（WS 与 REST 是两个独立通道，先发布后对齐会出现"旧快照覆盖新 tick"的窗口，而该窗口里的风控是基于错价做的）；静默分歧探测器（心跳对账，相对差 > 50bps 连续 2 次 → DIVERGED + 强制重快照 + 按 STALE 对待）覆盖"连接活着但喂垃圾"这类故障；**审计与成交估值不得用本地 tick**（成交估值必须用交易所回报的成交价）。

**两条通道都必须携带世代号（epoch / generation）**：WS 重连后交易所通常以新 epoch 恢复，若快照与缓冲 tick 没有共同的世代标识，旧 epoch 的缓冲 tick 会在新 epoch 的快照之后发布——**价格与顺序都错，却不产生任何错误**，而这恰好发生在最高频的异常路径（重连）上。规则：epoch 不一致 ⇒ 旧缓冲一律丢弃并重新快照。
**对齐失败 ≠「继续交易 + 告警」**：`STALE` 只是观测状态，不回答"还下不下单"。任何导致价格不可信的路径（对齐失败、静默分歧、限频被打忙导致快照取不到）必须与 comms loss 走**同一个状态机**（freeze-risk / 受限交易），默认只减不增。
另三条实现约束：缓冲上界必须有**全局界**（不能只有 per-symbol，否则内存 = 界 × 标的数）；**快照取数与下单必须各自独立的限频预算**（共享预算意味着"把下单通道打忙"就能把 bot 推进受限交易）；重对齐风暴需要抑制窗口链式开启，per-window 界挡不住。快照自身也要做年龄检查（只检查 tick 年龄不够）。

**参数标定门禁**：年龄预算、全局条数/字节上限、重对齐令牌桶容量这三个参数，**必须在录音-回放 harness（可注入：快照延迟 / 乱序 / epoch 变更 / tick 洪泛 / 共享预算占用）上标定之后才能写成代码常量**——把未标定的常量写进代码等于把猜测固化成生产行为。

**换语言的判据（J1–J6，触发前不换）**：J1/J2 触发 → 先 `worker_threads` 分片；J3/J4 触发 → 才上 sidecar，且必须同时交付"录音-回放 + 与 Node 对拍"的确定性测试；J6（要求含交易所往返 p99 < 1ms）→ 本架构不适用，需重新定位产品。

---

## 4. 事件骨架与存储

**结论：进程内 EventEmitter 做快环信号 + 自有 append-only journal 做事件骨架 + 四个物理分离的 SQLite 文件（`node:sqlite`）。**

| 存放 | 引擎 | 写入策略 |
|---|---|---|
| 订单 / 成交 | `orders.db` | `synchronous=FULL` |
| 审计 / 决策 journal | `audit.db` | append-only、单调 seq、批量提交 `NORMAL`、双水位保留期、可按 cursor 分页；`410 cursor-expired` 由快照表承接 |
| 行情快照 / K 线缓存 | `market.db` | `synchronous=OFF`（可重建） |
| 低频配置域 | `ctx.storageDomain` | 官方 json backend |

**实测依据**：JSON 整文件原子替换含 fsync（今天 `packages/dsh-home/src/fs-atomic.ts` 的写法）p50 7.97ms / p99 11.92ms ≈ **125 次写/秒上限**；`node:sqlite` WAL `synchronous=NORMAL` 单条持久写 p50 0.02ms / p99 0.105ms。差两个数量级 ⇒ 订单/成交/审计**绝不能**落今天的 JSON+fsync 面。

**A2 证伪**：rc.2 里官方只发货 `dsh-storage` / `dsh-storage-domain` / `dsh-storage-json`，**没有 SQLite backend**（README 推荐的 `storage-sqlite` 未发布）。若将来要用官方缝，成本是"自研一个 backend 走 `ctx.storage.backend.register()`"，而不是"组合即可"；即便有，订单/成交面也不放 storageDomain（无事务、内存权威、`domain/changed` 不是事务参与者、无回放语义）。

分区键 = `deskId`（多租户隔离）；`deviceId` 只做投递路由。

**三个 id 各司其职，不得互相顶替**：`clientRequestId`（客户端命令幂等，可见）｜ `clientOrderId`（核心 ↔ venue 的重复下单防护，**永不可见**）｜ `orderId`（观察面上的订单资源身份，**唯一可被客户端引用撤单的句柄**，必须在 `intent.recorded` 时、任何网络写之前分配）。
这条同时关掉一个洞：如果只有 `clientOrderId` 而没有 `orderId`，`submitted-unknown` 状态的订单在客户端侧**没有任何句柄可引用**，客户端的"可能已生效"清单无法闭环。
**终局要求**：`submitted-unknown` 必须能收敛到 `never-arrived` 或真实终态，**不允许存在永远悬着的订单对象**。

**`orderId` 形态**：`ord_` + UUID 规范形（`crypto.randomUUID()`），契约正则 `^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`，**不透明字符串、只比较不解析**（尤其不得解析时间或版本位）。日后 UUID v4→v7 时唯一的翻车点是**第 13 个 hex 是可观察的版本位**——换算法前必须确认没有客户端、日志或告警规则在按 `4` 匹配该位。冻结形状而非生成算法（日后 UUID v4→v7 不改格式）。**不加 venue slug**——venue 是路由层词汇、会变，把它冻进公开 id 就是自造 breaking。
**`clientOrderId` 形态由 venue 适配器决定**：各交易所对 clientOrderId 的字符集与长度上限不同（本仓**未核实**具体上限），核心持久化 `orderId ↔ venueClientOrderId` 映射，**不得假设长度上限**；venue 侧 id 只是字段、**永不作句柄**（`submitted-unknown` 时它根本不存在）。
**因果记一笔**：正因为 `clientOrderId` 必须随 venue 变，把 `orderId` 与它解耦才是公开契约可冻结的前提——后来者不要把两者重新合并。
**版本无关是结构保证的**：正则第三组是 `[0-9a-f]{4}` 而非 `4[0-9a-f]{3}`，即不钉版本位 ⇒ v4→v7 无需 schema 变更、无需契约版本号、无需客户端发版。唯一翻车点是契约之外的口头/临时匹配（日志 grep、告警规则、写死字面量的 fixture）——因此定两条机检规则：**禁止写死 `orderId` 字面量，一律经 factory 生成**；CI 加 grep gate 禁掉源码里形如 `ord_[0-9a-f]{8}-[0-9a-f]{4}-4` 的字面量。
**`clientOrderId` 不公开还有第二条理由**：它是核心 ↔ venue 的对账锚，而 venue 侧可能对它做规范化或截断（超长/非法字符的处理各家不同：拒绝、截断、静默替换——本仓未逐家核实）。一旦进入公开契约就有语义，客户端的幂等推理会建立在"我发的串 == venue 存的串"这个未必成立的假设上。设计上**不接受该假设**。

---

## 5. 授权：三层权威

| 层 | 位置 | 职责 | 是不是权威 |
|---|---|---|---|
| **L0** | `tradectl` | 唯一持凭据、唯一判 mandate、唯一触达 venue、唯一写交易审计；纯函数 `authorize`；单调预占账；哈希链审计；多级 kill switch | **是** |
| **L1** | `dsh(trading-bot)` | `tools.guard`（单调、只能拒绝）+ `tools/pre-execute`（表达层） | 否，fail-closed 双保险 |
| **L2** | 人类 | Ed25519 签名的 **mandate** 与 **one-shot permit** | 是（授权来源） |

**为什么审批不能只挂工具层**：统一闸门是 `ctx.on('tools/pre-execute')`（`packages/base/src/index.ts:121`），而服务缝 `evaluateOrderGate`（`packages/connector-binance/src/index.ts:271-285`）只有 `liveTrading` 拒绝 / simulate / live 三态、**不含审批判定**；同 profile 还挂着运行时插件安装器（`packages/base/cordis.patch.yml:232`），agent 侧还拥有 bash/fs 工具 ⇒ 任何新代码路径都能到达 `TradeService` 而不过审批。

**mandate 语义**：
- 结构含范围（市场/标的白名单/现货或合约）、硬限额（单笔名义额、总敞口、杠杆、日亏、回撤、下单频率）、软限额（超计划仓位但仍在上限内 → 升级）、时段与有效期、升级通道、撤销方式；带版本与哈希；**intent 结构里没有额度字段**——不可表达即不可自我扩权。
- **收紧随时可做；放宽必须重新授权**（主密钥 + 可信界面 + `isSubset` 判定；**未知字段视为放宽**）。
- 撤销默认 `allow-reduce-only`。
- **实盘开关必须迁出 agent 可写路径**：今天 `liveTrading: false` 写在 preset 资产 YAML（`packages/crypto/assets/preset/crypto-trader/agent.cordis.yml:48` 等）与 `packages/base/src/presets.ts:99`，位于 agent 可写文件里 ⇒ 实盘闸门第一段可被改写抹掉（红队 RT-04，已复核）。它已迁到人工签署的状态平面（`@dshtrading/authority`，见 §13.3 的可执行形式）：平面目录**必须显式配置**（`$DSH_TRADING_AUTHORITY_DIR`，没有默认位置）；读取端拒绝任何归运行 uid（即 agent uid）所有的平面——平面目录、两份文件与整条祖先链都要与 agent uid 分离，且目录/文件不得带 group/other 写位（`plane-not-isolated`）；开发形态必须由名字里带 dev 的显式 opt-in 打开（`$DSH_TRADING_AUTHORITY_DEV_SAME_UID=1`）并留痕，其授权带 `payload.dev=true`（在签名覆盖范围内，抹掉即验签失败），生产读取端拒绝。运营侧 `init`/`sign` 必须声明 agent 的 uid，声明成运行 uid 自身即拒绝；`init` 拒绝覆盖已存在的信任锚。
- 对外 API 里**永远不存在"打开实盘"这个端点**；「解除 kill」「放宽」属 `control` scope，**永不默认签发**。

**官方 `approval/request` 只做人工升级适配器**，不承担 mandate 判定：它要求 open turn、派发不带工具参数、唯一授予词是一次性的 `allowed-once`，语义不足以承载授权。

---

## 6. Agent 决策循环（慢环）

- **每 desk 一个声明式长驻 agent**（`dsh-agent-loop` 的 `Config.agents` + 稳定 `sessionId`/`resumeSessionId`）；**权威状态在执行核的外部账本**，会话是**可丢弃的推理缓存**；**换代优先于压缩**（初值 300k input / 200 轮 / 24h，须在 paper 阶段用真实用量重新标定）。
- **触发器由执行核自建 timer + 事件泵产生**，经 `ctx.agents.get(deskSessionId).followup(...)` 扇出到既有 desk 会话。
  - 不用官方 `dsh-schedule`：它绑定 `sessionId`（desk 会话换代即失联），且依赖 `dsh-api-session-controller` → peer `dsh-client-connection`，与"bot 不踩 web 栈"冲突；它还是 experimental bundle、不在已发布 profile 的 bundles 列表里。
  - 不用官方 `dsh-webhook`：唯一运行时动作是**新建 root Session**，唤不醒既有 desk 会话，且自称无队列/重放/重试/去重。
  - `followup` 每次都是一条独立普通 turn ⇒ **扇出必须节流**（不变量）。
  - **扇出机制已实测（U9）**：在 `dsh-base` + `dsh-headless`（无 webServer/connection）组合里，profile 声明 `agent-loop` 的 `agents: [{ id, sessionId }]` 可物化，且**对已存在 sessionId 是恢复历史而非新建空会话**（两次启动 `createdAt` 不变、帧数追加）。热路径用 `ctx.agents.get(id).followup()`；冷路径靠 profile 自声明 `agents` 行。
- **冷启动**（重启后未完成意图的处置由**核心**判定，不交给模型）：判据是"是否曾越过网络写边界"——
  - `intent.recorded` 有、`order.submitted` 无 ⇒ 回滚；
  - `order.submitted` 有、无终态 ⇒ **先查再定**（按 `clientOrderId` 向 venue 查；查不到标 `submitted-unknown`，**绝不自动重发**）；
  - 已 ack / 部分成交 ⇒ 按 venue 实际重建；存活挂单 ⇒ 默认撤销。
  - **不变量**：删掉全部会话 JSONL 后，核心仍能重建 desk 并继续工作。
- **模型不可用**三分级（freeze / derisk / flatten）**必须全部实现**，默认值由用户签字确认（工程侧推荐 `derisk`）。

---

## 7. 对外契约与客户端

### 7.1 一个领域服务，两个绑定

- **`/v1`（自持）**：HTTP/JSON 一元写 + WS 单向下行 + journal 游标补页 + **服务端驱动卡片**。移动端与网页驾驶舱走这条。
- **官方 Typert Remote**：仅作为 **GUI profile 的可选绑定**（dsh 客户端原生集成）。移动端**不吃** Typert wire——它的信任栅栏是同源浏览器会话、"绝不建立身份"、无按设备撤销；且 wire 是内部协议，会把 90 天的 App 发布节奏绑到 DSH cohort 上。

### 7.2 三平面与 A0

按 scope 划分：`read`（观测）/ `command`（指令）/ `control`（控制，永不默认签发）。
**A0「永不下线」最小集**（kill / pause / 状态 / 升级应答等 6 项）：可用性由结构保证——kill 落成执行核每次读取的原子状态，A0 路由先于行情面与 agent 注册。不依赖 agent 循环、行情面、LLM 任何一环。

**控制面不可达 ≠ 授权失效**：按 mandate 预授权朝风险更低一侧降级（默认"不再新增风险、保留保护性挂单"）；dead-man 的触发条件是**bot 自己心跳失活**，不是"手机连不上"；恢复连接必须产出 **gap report**（断连期间的错过触发、被拒意图、降级动作、持仓变化）。

### 7.3 版本与兼容

URL major + 只增不减 minor + `X-Dsht-Caps` 能力交集 + `426 CLIENT_TOO_OLD`（可执行判定）；服务端兼容 N-2 个 App 版本（内部分发下 App 版本漂移是常态）。

### 7.4 客户端技术栈

- **网页驾驶舱**：React 18.3 + TS 5.9 + Vite 7 的**独立 SPA**，由 bot 的 edge 行托管（不引 dsh `webserver` 行），复用现有 CSS Module 设计令牌。
  - **静态壳 vs 令牌的裁决（2026-10-02）**：SPA 的**静态壳**（HTML/JS/CSS/图标，仅 GET、精确路径白名单）可免令牌——浏览器导航带不了 `Authorization` 头；**一切数据与命令端点一律 Bearer**，壳内 JS 用设备令牌取数、令牌存浏览器存储而非 cookie。白名单**只准列静态资源、永不列数据路径**，写死在常量表里（与 `edge.ts` 的 `PUBLIC_PATHS` 同款）。
- **移动端**：**React Native / Expo SDK 57（RN 0.86）**，EAS Build 内部分发 + EAS Update OTA 与回滚。
- **共享**：`@dshtrading/contract`（零第三方依赖，运行期值也在此）+ `@dshtrading/client-core`（transport / store / 卡片渲染器）。诚实比例：**契约 100% / 数据层约 90% / 渲染 0%**（React DOM 组件不能在 RN 复用）。
- **卡片协议**：12 个封闭 CardType + 封闭 Field/Action 联合 + 必填 `fallbackText`；4 条"不退化"硬规则（可机检）+ 12 个硬上限棘轮；**任何含未知 closed 枚举值的卡片渲染为不可操作态**（禁用全部 Action）。
- **观测面不依赖 tick 流**：行情只以卡片快照 + `data.freshness` 出现，流式行情是独立增强项。
- **设备鉴权**：配对注册 + 设备密钥（Keychain/Keystore）+ 作用域 + 逐设备撤销；**不用 cookie**（不引 CSRF 面）。**部署面已裁决为"仅内网"**（见 §12.4）：不设公网入口，但仍逐设备令牌、仍作用域分级——**内网不等于可信**；传输走内网 TLS（自签可接受）或私网叠加；交易所凭据永不下发。

### 7.5 两种部署形态（同一 owner 单写者）

- 配了 bot：GUI 面（网页/移动/桌面壳）**全部是纯客户端**；桌面壳新增"附着到 bot URL"模式（扩展现有 127.0.0.1:3080 handoff 机制）。
- 没配 bot：本地 host 照常跑 `trading-web` = 辅助交易独立工作台，行为不变。
- **不得混显**：数据源是会话级单例、不做隐式回退；每条数据带 `sourceId`，渲染层拒绝与当前源不一致的数据；切换期只读 + 双源对账视图。
- 同一份 home 同一时刻只允许一个 host 写者。

---

## 8. 市场扩展接口（SPI）

核心只认 **OrderIntent** 领域模型；venue adapter 声明能力：市场数据（REST/WS/流）、订单类型（市价/限价/止损/OCO/条件单）、精度与最小下单量、交易时段与日历、限频、保证金与杠杆、paper 模式、幂等语义（`clientOrderId`）、对账读取面、凭据获取方式，以及**是否需要本地桥**（A 股 MiniQMT 为 Windows 本地网关、IBKR/Futu 需本地 gateway ⇒ 这些市场不是"纯 Linux 服务器"形态，SPI 必须允许 adapter 声明）。
现有 `tradingMarketDataRegistry` / `tradingTradeRegistry` / `tradingMarketRouter` 是这套 SPI 的雏形，向上补齐 capability + intent 即可；crypto 首发，其余市场不动 core。

---

## 9. 稳定性工程

- **safe boot**：启动先与 venue 对账，对账未完成前禁止新增风险；**对账权威源是 venue，不是日志**。
- **统一受限状态机（唯一命名：`RiskGate`）**：行情 `STALE`、对齐失败、静默分歧、comms loss、限频被打忙——**所有导致"不能正常交易"的路径共用这一个状态机**，不再各写一套（此前工作稿里确实是两套，违反"一个事实只有一个家"）。
  - **两套词汇表不得相交**（安全路径上的命名碰撞是缺陷不是风格——实现期必然有人写出 `if (level === "unaligned")` 去判价格状态）：
    - **标的级价格状态 `alignment`**：`aligned`（可开新仓）/ `unaligned`（禁开新仓、可减仓）/ `stale`（只可减仓撤单）。
    - **desk 级交易权限 `level`**：`normal` / `caution` / `reduce_only` / `halt`。
  - 判定取**合取**而非提升：`openRiskAllowed = (level ∈ {normal, caution}) && (alignment == "aligned")`——两个维度独立判定取与，绝不把标的级状态提升为 desk 级。
  - **降级必须自愈而非闩锁**：只降级肇事标的，下一次快照成功后自动回到 `aligned`；**全局触顶不得让整个 desk 丧失开仓能力**（否则单个病态标的即可 DoS 整个 desk），必须显式定义全局淘汰策略，且"连续禁开新仓超过 T 秒"必须升级到人。
  - **`halt` 只由带外触发**（操作者 CLI / venue 侧 / dead-man），不是普通风险输入故障的产物；普通故障止于 `reduce_only`。**自动路径上 `halt` 永不可达**——若发现自动触发 `halt` 的路径，一律改为 `reduce_only` 或改为带外确认。**前提**：凡可能进入 `halt` 的场景，保护性订单必须已经存在于 venue 侧（venue 原生条件单/OCO），即"保护不依赖 bot 活着且可信"——否则最严状态就是陷阱。带外退出通路必须演练过。
  - 人工升级（escalation）共用同一条时间轴，但不是第二套状态机。
- **故障模型**逐类给降级语义（行情断流、交易所限频/故障、模型 API 不可用、进程崩溃、磁盘满、时钟漂移、证书过期、多实例争抢……）；**数据新鲜度门**：行情陈旧/断流 → 可平不可开。
- **dead-man 三层**：快环看门狗 / venue 原生（交易所侧条件单）/ systemd；**不依赖 agent 存活**。
- **kill switch 多级**：desk 暂停 / 全局停机 / 撤销 mandate / venue 端 cancel-all 与紧急平仓；任何界面可达，一键生效。
- **背压按面区分语义**：tick 可合并丢弃、intent 绝不丢且预占带 TTL、journal 阻塞生产者。
- **可观测性**：OTel Metrics（不全量 trace tick）+ 结构化日志 + 告警分级 + gap report。

---

## 10. 迁移与兼容（实施顺序见决策记录）

- **按包边界切，不按市场切**：host 平面包（bot 与 GUI 都装）/ GUI 平面包（只有 GUI 装）/ bot API 平面包（两者都装）；`base` 保留 host 共享行，`client-ui-*` 迁往新的 GUI 层，`/dshtrading/api` 迁往 bot API 层；**行 id 与 name 一字不改地整块搬家**。
- **行 id 是跨版本公共契约**（比 HTTP 路径更硬）：`dsh-trading-*` 命名空间一经发布即冻结；**拆包之前必须先补行 id 唯一性机械门禁**——今天全仓没有任何门禁，且已存在 2 处重复 id（`dsh-trading-dsh-i18n`、`dsh-trading-client-ui-masters-quotes` 同时被 base 与各自包内 patch insert）。
- **家族版本**：bot 与 GUI 必须留在同一 changesets fixed group、同一 tag、同一 updater 家族（独立发版会同时打断 updater / 桌面 seed / preflight 三段）。
- **home 不拆家**：做"store root 分离 + 单写者"，并解决宿主运行时文件（`storages/` 等）的写者归属。
- **可以踩**：profile/bundle、storage backend registry、approval、agent-presets、typert-protocol、agent/agent-loop 的公开 API；**不可踩**：按官方行名做 `disabled: !!js`（base 现有两处）、官方 remote 事件转发白名单（宿主常量）、web 栈信任栅栏、experimental bundle、未发货的 SQLite backend。
  - **新增依赖任何官方缝之前必须先过三问**：① 它是不是官方承诺的契约（文档级承诺，而非实现细节）？② 上游变更时我们会不会失败得响亮？③ **它静默失效时我们能不能看见？** 三问**逐问作答**，不接受"已评估"三个字；缺一问即视为未满足。第三问最容易被绕过——人对新缝的默认判断永远是"显然没问题"。
  - **逐条作答的落点**：[官方缝清单（三问逐条作答）](dsh-seam-inventory.md)。那里给出每条缝的依赖点、官方原文依据、失败响亮程度与**可执行检测点**，以及判定为"未满足 / 部分满足"的缺口清单（带负责人阶段与成本）。**本节写"能不能踩"的结论，该文件写"踩了以后怎么知道它断了"——两者一起改。**
- **红队要点**：updater 的 `updates-manifest-<tag>.json` 与被更新 payload 挂在同一个 Release（信任锚自证）——需独立信任锚或签名校验。
- **归属判据**：「一个事实只有一个家」的**家要选在适用范围最大的那一层，不是选在最先发现它的那一层**——本轮多起归属争论（含"保护不依赖任何我方组件活着且可信"应当归到哪一层）都是靠这一句一次性收敛的。
- **改名的纪律要有一个家**：重命名清扫规则（分类全量核对、规范性用法必须换、被否决记录留原名并标注弃用）已落在 [命名与闸门词汇约定](.agents/notes/implemented/process/2026-08-29-naming-and-gate-vocabulary.md) 的"重命名与清扫纪律"一节。**没有这个家，它会在下一次改名时重新被踩**——而这正是本章（兼容性）整条命题的形态：改名会在旧引用处静默失效。

---

## 11. 上线路径

shadow（只决策不下单，记录"本会怎么做"）→ paper（交易所模拟盘 / 内置 dry-run）→ 小额 live（紧 mandate）→ 放大。每档有量化验收：决策与执行一致性、滑点、拒单率、policy 命中/拒绝分布、升级率、回撤。**升级率长期偏高说明 mandate 设计失败**，不得用降低告警的方式"优化"。

---

## 12. 已裁决（2026-10-01，部署前提：仅内网运行）

1. **模型不可用时的默认动作 = `derisk`**（分批、限价、带滑点上限）；`freeze` / `derisk` / `flatten` 三态**必须全部实现**，默认值由 mandate 承载而不是写死在代码里。
2. **撤销 mandate 的默认语义 = `allow-reduce-only`**（只许减仓、撤单，不许开新仓）；**不提供"撤销即全平"作为默认**——紧急平仓只能由人显式下发 `flatten` 命令（二次确认 + 审计）。
3. **mandate 带到期**：默认 30 天，到期前 3 天提醒；续签 = 重新签名（不是静默延期）。到期未续 ⇒ 自动降为 `reduce_only`。
4. **部署面：只在内网运行，不设公网入口。** bot/edge 只监听回环或内网接口；**内网不等于可信**——设备级令牌、逐设备撤销、作用域分级一条都不省；传输用内网 TLS（自签可接受）或私网叠加（WireGuard/Tailscale 类），不引入公网反向代理与公网证书链。
5. **首发 desk = 1 个 desk / 1 个 crypto 账户**（Binance 或 OKX，按测试环境可用性二选一）；架构第一天就是多 desk 多租户，但不提前铺第二账户。
6. **叙事变更时点 = 与上线路径同批**：shadow → paper → 小额 live 全部走完后，才改 README/FAQ 的"不是无人值守的实盘交易机器人"口径；在此之前对外口径保持不变。

---

## 13. 不变量清单（实现的硬约束，逐条可验证）

> **总则**：**不变量若不以可执行断言的形式进 CI，它与散文无异。** 本清单每一条都应落到一个可运行的检查上（单测 / 属性测试 / grep 门禁 / 启动断言）；暂时无法执行的，必须**显式标注为"约束实现方的验收门禁"**，不得静默降级成文档里的一句话。
>
> **成熟度四态（读法，Lead 初判，实现方落地时逐条确认）**：
> ① 已定义 + 断言可立即写；② 已定义 + 断言待建（写明依赖）；③ 只能留证据（准入门禁 + 可查演练记录，缺记录即降级）；④ **治理型条目**——本质是决策规则而非系统属性，检验对象是"决策记录存在且被引用"，不是代码行为（例：K 判据只换机制、不退回架构）。**识别启发式**：凡是形如"**当 X 发生时，必须做 Y 而不是 Z**"的裁决都落进这一类——它约束的是决策而非系统行为，因此判据只能是"记录存在且被引用"。（本轮两个独立方向各自撞上同一条裁决，说明这类条目散落在决策里、不散落在系统里，最容易漏。）
> 初判分布：**①** 1/2/3/4/5/6/9/11/16/17/20/21/22/24/26；**②** 7/8/10/12/13/14/15/18/19（分别依赖对账实现、核心实现、行情 harness 标定、桌面壳附着模式、两套部署模式落地等）；**③** 23/25；**④** 本清单不列治理型条目——那类（如"K 判据只换机制、不退回架构"）进决策记录，不进不变量清单。
> **不得把 ①② 读成"已验证"**：按现状，本清单里**没有一条处于"已验证"状态**——方案尚未实现。把"已定义"统一读成"已验证"会系统性高估这份文档的成熟度，而这在自动交易场景里是有代价的。
> **边界情形**：本条**不能**推导出"一切不变量都必须是单元测试"，只能推导出"**一切不变量都必须有可执行的检验方式，且不许把测不到的伪装成测过的**"。确实测不到的那一类（例：保护不依赖任何我方组件活着且可信——要验它得真的把我们都关掉），正确出路是把它变成**必须留证据的东西**（准入门禁 + 可查的演练记录：谁、何时、结果；无记录即视为未满足，`halt` 降级为 `reduce_only`），**不是删掉它，也不是假装它被测过**。

### 授权与凭据
1. **唯一凭据持有者 = 唯一授权判定者**：只有执行核持有交易凭据、只有执行核判 mandate、只有执行核能触达 venue。
2. **核心与 agent 宿主不得共享 OS principal**（负面不变量：不写"某工具当前不存在"，只写"不得共享"）。
3. **实盘开关不在 agent 可写路径上**：它属于核心侧、uid 保护、人工签署的状态平面；对外 API 永远不存在"打开实盘"这个端点。**可执行形式（已落地）**：`packages/authority` 的读取端（a）要求平面目录显式配置，未配置一律拒绝（`dir-not-configured`）；（b）拒绝任何归运行 uid（agent uid）所有的平面——检查平面目录、两份文件与**整条祖先链**的属主，并拒绝带 group/other 写位的目录/文件（`plane-not-isolated`）；（c）开发形态只能由名字里带 dev 的显式 opt-in 打开并留痕，其授权带签名覆盖的 `payload.dev=true`，生产读取端拒绝（`dev-grant-not-accepted`）。`scripts/live-trading-gate.mjs` 的 LG4 每次真跑一遍「自铸信任锚 + 自签授权」并断言仍被拒。**仍未落地的是部署属性**：生产上的两个真实 uid 分离要等 P2/P5 的部署验证——本机同 uid 只能证明「同 uid 拿不到授权」，不能证明生产隔离强度。
4. **`intent` 结构里没有额度字段**——不可表达即不可自我扩权；收紧自动生效，放宽需主密钥 + 可信界面 + `isSubset`，**未知字段视为放宽**。
5. **approval seam 失效不得放行**：宿主侧只做单调拒绝，永不作为授权来源；`approval/request` 只承担人工升级适配器。
6. **撤销默认 `allow-reduce-only`**；任何"停止/中断"路径都不得被理解为"已回滚"（取消不是补偿动作）；`cancel_all` 作用域必填，不接受裸"全撤"。

### 执行与对账
7. **对账权威是 venue，不是日志**；safe boot 对账先于开门。
8. **`submitted-unknown` 是中间态不是终态**：终态集合完全枚举且必达（含 `never-arrived`），**绝不自动重发**，**不允许存在永远悬着的订单对象**。
9. **三个 id 不得互相顶替**：`clientRequestId` 可见 / `clientOrderId` **永不可见**（外泄等于客户端能绕开核心直接对 venue 讲话）且**形态随 venue 适配器变、不得假设长度上限** / `orderId` 是**不透明字符串**（`ord_` + UUID，只比较不解析、不含 venue slug）且是唯一可被客户端引用撤单的句柄，在 `intent.recorded` 时（任何网络写之前）分配；核心持久化 `orderId ↔ venueClientOrderId` 映射。
10. **冷启动自足**：删掉全部会话 JSONL 后，核心仍能重建 desk 并继续工作。

### 行情与价格
11. **tick 流是优化，快照是契约**：观测面不依赖 tick 流；风控不把 tick 流当唯一真相。
12. **epoch 不一致 ⇒ 旧缓冲一律丢弃并重新快照**。
13. **价格不可信的路径必须映射为受限交易**，与 comms loss 走同一状态机（默认只减不增）——不是"继续交易 + 告警"。
14. **缓冲必须有全局界；快照与下单各自独立限频预算**（共享预算 = 打忙下单通道即可让 bot 降级）。

### 进程与部署
15. **同一份 `$DSH_HOME` 同一时刻只允许一个 dsh host 写者**。
16. **edge 是唯一对网络暴露的进程**；核心只监听 UDS，不监听任何网络接口。
17. **UDS 目录归核心、0750（组可进入不可写）+ socket 文件 0660**；inode 校验失败 ⇒ 立即 freeze-risk，不自动重绑。
18. **生产环境 UID 分离**；开发/单机可退化但代码路径、socket 权限模型、凭据加载位置不得分叉。四条禁止的降级：权限不符不得降级为无鉴权；核心不可达不得由宿主自行下单；凭据只住核心侧；独立 uid 不可用必须显式声明为开发形态。

### 触发与预算
19. **控制面不可达 ≠ 授权失效**：按 mandate 朝风险更低一侧降级；dead-man 的触发条件是 **bot 自己心跳失活**，不是"手机连不上"；恢复必须产出 gap report。
20. **扇出必须节流**（`followup` 每次都是一条独立普通 turn）；迟到触发只能减风险。
21. **行 id 是跨版本公共契约**：`dsh-trading-*` 命名空间一经发布即冻结，且必须有机械唯一性门禁。

### 状态机与参数
22. **受限状态机只有一个（`RiskGate`）**：行情 STALE、对齐失败、静默分歧、comms loss、限频被打忙共用它；**`alignment`（标的级价格状态 {aligned, unaligned, stale}）与 `level`（desk 级交易权限 {normal, caution, reduce_only, halt}）两套词汇表不得相交**。判定取**合取**而非提升，其可机检断言为：**`level` 的任何变更都不得以单个标的的 `alignment` 作为唯一输入**（标的级绝不提升为 desk 级）——这条是本节唯一能被单测直接钉住的断言，因此必须留在不变量清单里，不能只活在散文里。
23. **未标定的参数不得写成代码常量**：行情缓冲的年龄预算、全局条数/字节上限、重对齐令牌桶容量，必须先在可注入（快照延迟 / 乱序 / epoch 变更 / tick 洪泛 / 预算占用）的录音-回放 harness 上标定。
24. **降级自愈不闩锁**：全局触顶只降级肇事标的，不得让整个 desk 丧失开仓能力（单标的 DoS）；淘汰策略必须显式；连续禁开新仓超 T 秒必须升级到人。
25. **`halt` 只由带外触发，且保护必须先存在于 venue**：普通风险输入故障止于 `reduce_only`；**`halt` 在自动路径上永不可达**——任何自动降级封顶在 `reduce_only`，若某方案里出现自动触发 `halt` 的路径，一律改为 `reduce_only` 或改为带外确认；**保护不依赖任何我方组件活着且可信**（比"不依赖 bot"更强——不含核心进程、不含 edge、不含通知通道）是 `halt` 可用的前提；venue 无原生条件单/OCO 时，`halt` 必须降级为 `reduce_only`，并把这一点作为该 venue 的**接入准入条件**。带外退出通路必须演练过。**可复述判据**：对任何安全机制问一句——「我方全挂时它还成立吗？」答否 ⇒ 必须有一条带外替代。
26. **审计 provenance 必须足以重建判定**：不只标识价格，还须钉住持仓/敞口快照版本与 mandate 版本指针——否则回放会拿今天的持仓复现当时价格上的判定，verdict 不同却看不出原因。

> 推导与证据链在四份工作稿（进程与基础设施 / Agent 决策循环与授权 / 对外契约与客户端 / 兼容性与红队）中；**实现以本清单为准**，工作稿保留的是断言推导、验收前提与攻击面分析。
