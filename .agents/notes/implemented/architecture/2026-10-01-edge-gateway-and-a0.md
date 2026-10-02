# edge 网关：唯一网络暴露面、逐设备令牌与 A0「永不下线」

日期：2026-10-01 · 阶段：P2 步骤 4 · 卡片：21b6b892 · 包：`@dshtrading/tradectl/edge`

## 事实

- **只有这一处网络暴露**：`createEdgeGateway` 监听回环或内网接口；`0.0.0.0` / `::` 显式抛错拒绝（那会把执行核变成公网可编程下单端点）。
- **配对与作用域**：一次性配对码（`randomBytes(16)`、TTL 10 分钟、**先消费再校验**——任何一次尝试都不能让同一个码复活）→ 兑换返回设备 id + 明文密钥（只此一次，库里只存 sha256）。作用域 `read` / `command` / `control`（词汇表的家是 `@dshtrading/contract/scopes`，edge 直接引用它的 `grantableByDefault`/`isScopePlane`）：**请求里显式给出的平面照签（read 是底线），`control` 一律剔除**——只能事后由运维 `grantControl` 授予。请求里要了却没签发的平面**不静默吞掉**：响应体的 `deniedScopes` 逐条点名；写了认不出的平面（如 `admin`）⇒ `400 PAIR_SCOPES_INVALID`，且**配对码不被消耗**（参数写错不该烧掉用户的一次性码）。
- **鉴权**：`Authorization: Bearer <deviceId>.<secret>`，服务端只存 `sha256(secret)`（明文只在配对响应里出现一次），比对时对两侧散列做 `timingSafeEqual` 常数时间比较；**不用 cookie**，所以没有"浏览器自动带凭据"的路径，也就没有 CSRF 面。逐设备撤销（`revokeControl` 收回 control / `revoke` 整台作废）**立即生效**（没有缓存窗口），并且随注册表落盘**跨重启存活**。
- **鉴权闸门盖住 A0 与整个业务面**：只有写死在 `PUBLIC_PATHS` 表里的路径（`/pair/redeem`、`/healthz`）在鉴权之前，**表外的一切路径**——A0 六端点、`/v1` 数据面与命令面——都先 `authenticate`，缺令牌/伪造令牌 `401 EDGE_UNAUTHORIZED`，路径存在但 scope 不够 `403 EDGE_SCOPE_REQUIRED`（附 `required`），**鉴权先于 404**（未鉴权的调用方连"哪条路径存在"都不该看出来）。表不按前缀匹配：给某条子路径开口子不等于把整个 `/v1` 放行。
- **业务路由的作用域与设备下发**：`registerBusinessRoutes` 登记时可声明 `requiredScope`（缺省 `read`，命令面路径必须显式声明 `command`）；粒度按**动作**而不是 HTTP 方法——契约的 `ACTION_SCOPE` 里 ack/dismiss 是 read、approve/reject 是 command、kill/flatten 是 control，它们走同一条 POST 路径，动作级判定由 `/v1` 面用 edge 交下来的设备做：handler 的第三个参数就是**已鉴权的设备**（`device.scopes`），宿主据此传 `handleV1`/`createV1Stream` 的 `scopes`，不必自己再解一次令牌。
- **业务路由登记 fail-fast**：登记到公开路径或 A0 路径上直接抛错（那两处永远轮不到业务 handler，静默失效是最难查的一类 bug），声明了不认识的 scope 同样抛错。
- **A0 六端点**：`/a0/ping`、`/a0/status`、`/a0/kill`、`/a0/pause`、`/a0/resume`、`/a0/ack`，在 `createServer` 里**先于**业务面判分支（两者共用同一道鉴权闸门）；kill/pause/resume 要 `control`，其余要 `read`。
- **健康检查 `GET /healthz`**：公开、只回 `{ok, atMs}`，不读注册表、不读 kill 状态、不碰业务面——systemd/监控探针既没有也不该有设备凭据，而探针要能在业务面全挂时照样 200。非 GET/HEAD ⇒ 405。
- **kill 是原子状态**：`writeKillState` 写同目录临时文件再 `rename`（POSIX 同分区 rename 原子），核心每次风险判定都重新 `readKillState`——没有任何缓存能让一次 kill 被"忘记"。
- **静态壳托管（§7.4「静态壳 vs 令牌」裁决，2026-10-02 补）**：`EdgeOptions.shell.dir` 给了就托管驾驶舱的静态壳 —— 壳入口与壳资源**免令牌**，但只有 **GET/HEAD** 且只对**枚举出来的精确路径**（不做任何前缀匹配）。免令牌集合 = 常量入口表 `SHELL_ENTRY_PATHS`（`/`、`/index.html`）+ 启动时从壳目录枚举出的静态文件（`createStaticShell`）；规则是常量（入口表 + `SHELL_EXTENSIONS` 白名单 + 命名空间守卫），集合在启动时定死。发送规则复用 api-v1 的 `serveStatic`（遍历/扩展名/缓存/预压缩协商一处家），所以 `.gz`/`.br` 兄弟文件不会各自变成一条公开路径。数据面（`/v1/cards`、`/v1/commands`、`/a0/*`、`/pair/*`、`/healthz`）**从不进白名单**：非 GET/HEAD 的请求刻意不落进壳分支，于是 `POST /index.html` 无令牌是 **401**（有令牌才是 405）。三条守卫都在**启动期**抛错：壳目录里有非静态文件（`.json`/`.txt`/未知扩展名）、路径落在数据命名空间（`/v1/` 下只有 `/v1/assets/` 允许）、业务路由登记到壳路径上（`collides with a static shell path`）。
- **运维通道（本地 UDS，2026-10-02 补）**：`--ops-socket` 给了就绑一条**只服务 `grant-control` / `revoke-control` / `revoke-device`** 的 UDS（长度前缀帧协议与核心 UDS 同源，`src/uds.ts`），它是 `control` 唯一的生产签发与收回入口（见下"运维 control 授予"）。不做网络端点：授予 control 需要"先有 control 才能授权 control"的死锁，那条端点必然免令牌，等于把紧急刹车放到网络面上。
- **设备注册表落盘（2026-10-02 补）**：`createDeviceRegistry({ storePath })` 是文件后端 —— 路径由入口的 `--device-registry`（**必填**）给出，含设备 id / name / scopes / `createdAtMs` / `sha256(secret)`，**没有明文密钥**；文件权限 0600，写入是同目录 temp + rename（崩溃只会留下上一份完整状态）。启动时加载：文件不存在 = 空表（首次启动的正常状态），**损坏 / 版本认不出 / 条目形态不合规 ⇒ 抛错**（入口退出码 5，fail-closed，不许静默当空表）。每次授权变更**先落盘再改内存**：写不进去就当场抛错，不出现"内存里已生效、重启就没了"。配对码仍是进程内的（一次性、10 分钟 TTL，跨重启存活没有意义）。注册表**只有 edge 一个写者**（文件归 `dsh-trade-edge`、0600；核心读不到它）：能写这个文件的人就能签发授权，所以它必须是 edge 独占。

## why（三条关键取舍）

1. **内网不等于可信**：`--host` 只允许回环/内网接口，但仍然逐设备令牌 + 作用域分级。把"在内网"当信任前提，等于让任何能连上内网的东西都能下单。
2. **control 永不默认签发**：它是"停掉一切"的开关。默认发给每个新设备，等于把紧急刹车交出去；所以配对路径里 `control` 被显式过滤，只能由已在册的运维动作 `grantControl` 打开。
3. **A0 先于业务面**：行情挂、agent 挂、账本锁死时，kill 必须仍然生效——所以 A0 只依赖边缘自己的注册表与核心的 kill 文件，业务路由表是分开的 `Map`，业务 404/500 与 A0 完全解耦。

## 测试（`edge.test.ts` 17 例 + `edge-pairing.test.ts` 8 例 + `edge-shell.test.ts` 10 例 + `edge-ops.test.ts` 9 例 + `edge-registry.test.ts` 8 例 + `edge-registry-restart.test.ts` 4 例，全绿）

配对码一次性（二次兑换 UNKNOWN）、过期码被拒（注入时钟推进 11 分钟）、配对默认只给 read 且请求 control 拿不到 + grantControl 后才有、**业务面无令牌 401 / 伪造令牌 401（且 handler 一次都没执行）/ 业务面命令路径 scope 不足 403**、不存在的路径无令牌 401 而有令牌 404、无令牌 401 / 伪造令牌 401 / read 设备打 kill 403（且 kill 未落盘）、撤销即时生效（200 → 401）、响应无 `set-cookie`、**行情面抛错时 kill 仍 200 且原子落盘且核心读得到**、pause 不清 kill 位而 resume 清两位、A0 六端点全 200 且业务 404 不影响、**免鉴权路径表就只有配对与健康检查两条（表里免令牌、表外的 A0 与业务面一律 401）**、健康检查业务面全挂时仍 200 且只收 GET/HEAD、业务路由登记到公开路径/A0 路径即报错、拒绝绑定 0.0.0.0。

**kill 通路全链路（真实设备）**：真实 HTTP `POST /pair/redeem`（显式要 `command`）→ 拿到 `read+command` 凭据 → 业务面 200 但 `/a0/kill` **403**（配对绝不签发 control、kill 文件没被动过）→ 运维 `grantControl` → **同一条凭据 `/a0/kill` 200**，kill 文件里 `reason` 就是这台设备。配对端点侧另有三例：显式要的 `command` 真的签发并能打进命令面、要 `control` 不签发但 `deniedScopes` 如实点名、认不出的平面 400 且码不被消耗。

**注册表落盘 8 例**（`edge-registry.test.ts`，真文件真权限）：配对后落盘内容完整且**只有 `sha256(secret)`**（明文不出现在文件里）、权限 **0600**；**原子性用硬链接哨兵钉死** —— 变更前把当前 inode 硬链一份，变更后哨兵仍是旧内容（原地改写会让哨兵跟着变），且目录里不留 `.tmp-` 残件、rename 后权限仍是 0600；文件不存在 = 空表且读不产生写；**九种损坏形态**（非 JSON / 顶层数组 / 缺版本 / 版本认不出 / devices 非数组 / id 形态坏 / 作用域认不出 / secretHash 非散列 / id 重复）**逐个抛错**且消息点出文件路径与 fail-closed；收回 control 只改那一个平面（重启后 read+command 仍在、control 不在）；整台作废后从盘上消失、其余设备不受影响；不在册设备 `revokeControl` 返回 false 且盘上不多出设备；不给 `storePath` 时仍是纯内存（既有调用方零改动）。

**重启与撤销语义 4 例**（`edge-registry-restart.test.ts`，真 `bin/edge.mjs` 进程、同一文件路径反复起停）：第一进程配对 A 并授予 control、A 能 kill 200 → 第二进程（重启）里 A 的授权仍在、把 A 整台作废后它的凭据立刻 **401**、新配对的 B 授予 control 后能 kill 200 → 第三进程（再重启）B 仍是 `read+command+control` 且 kill 200、A 仍是 401、盘上只剩 B；只收回 control 的设备重启后仍是 `read+command`（kill 403、status 200），重启后再撤销一次得到 `OPS_CONTROL_ABSENT`（证明运维通道读的是重新加载的注册表）；**注册表文件损坏 ⇒ 入口退出码 5 拒绝启动**；不给 `--device-registry` ⇒ 退出码 2。


## 配对客户端流程（P4 步骤 4 客户端一半，2026-10-01 补）

`packages/tradectl/src/pairing-client.ts`：把配对这件事的逻辑抽成**与传输无关**的模块（手机怎么够到 edge 还没定，但配对逻辑不依赖它）。

三条立场：

1. **密钥只走安全存储端口**：模块自己不落盘、不打印；`deviceId.secret` 交给注入的 `storage`（移动端实现为 Keychain/Keystore）。以端口形式强制，而不是靠约定。
2. **配对码一次性、失败不重试**：重试同一个码在语义上毫无意义，只会掩盖"用户拿的是旧码"这个事实；要重试就换新码。提示文案直接说"请在驾驶舱重新生成"。
3. **401 ⇒ forget() 清掉本地密钥、回到未配对**：设备被 revoke 后继续拿旧密钥重试是最糟的状态（看起来在跑、其实每条请求都被拒）。

测试 5 例**对着真实的设备注册表**跑（进程内，不打桩注册表逻辑；存储用契约假件）：配对成功且密钥进安全存储、客户端默认只请求 read 平面（服务端按请求签发的规则见上）；同码不可二次使用；过期码给人话提示；revoke 后 forget 清空；`authorizationFor` 的格式与 edge 解析约定一致（按第一个点切分）。

### 一个只会在运行时暴露的形状错（值得记）

第一版测试把 `registry.redeem` 直接当端口用，而注册表返回 `{ device, secret }`、端口声明是 `{ deviceId, secret }` ⇒ `deviceId` 恒为 undefined，断言在**运行时**才炸。

**根因不是笔误，而是范围问题**：本仓的 `tsconfig` 只覆盖 `src`（测试目录不在 `tsc --noEmit` 范围内），所以**端口形状不匹配在类型检查里根本看不见**。修法是在测试里写显式的映射层（`{device,secret} → {deviceId,secret}`）—— 那正是"进程内调用或未来的 HTTP handler"要做的事，写在测试里顺带把端口契约说明白了。


## 配对端点 `POST /pair/redeem`（P4 步骤 4 服务端一半，2026-10-01 补）

此前 `pair` 只存在于注释与注册表 API 里 —— **没有任何 HTTP 面**，手机拿不到配对码、也没端点兑换它。现在 edge 提供这一条路径。

**它是两条公开路径之一**（另一条是 `/healthz`）：它本身就是用来换取鉴权凭据的。位置紧接在路径解析之后、A0/业务面分支之前。

- 成功：`200 { deviceId, secret, scopes, deniedScopes }`（密钥只返回这一次；注册表里只存 sha256；`scopes` 是**实际签发**的、`deniedScopes` 是请求了但没签发的）；
- 失败：`400 { code: PAIRING_CODE_UNKNOWN \| PAIRING_CODE_EXPIRED }`；非 POST ⇒ 405；体不是 JSON 对象/超 4KB ⇒ `400 PAIR_BODY_INVALID`；`scopes` 里有认不出的平面 ⇒ `400 PAIR_SCOPES_INVALID`（码不被消耗）；
- 作用域：请求里显式给出的平面照签（read 是底线，`command` 要显式要），**`control` 一律不签发**并在 `deniedScopes` 里如实回报；`/a0/kill` 对该凭据返回 403 —— 测试里断言了这一点。

### 防爆破：同源失败上限（这是内网暴露下的必要项）

既然 edge 允许绑内网接口（见下"更正"），端口在局域网内可达 —— 没有上限就等于把配对码交出去给人爆破。所以加了**同源失败计数**：窗口 10 分钟、上限 8 次，超过即 `429 PAIR_RATE_LIMITED`。

**语义是 fail-closed 的**：达到上限后**连正确的码也会被挡**。这是刻意的 —— 防爆破不能让"也许这次是对的"绕过；且配对是罕见的人工操作，"锁一会儿"比"可能被爆破"代价小得多。与项目一贯立场一致（无头 fail-closed、不静默降级）。

**静态壳与运维通道的测试**（2026-10-02 补）：`edge-shell.test.ts` 10 例 —— 无令牌 `GET /index.html`/`/`/`/v1/assets/assets/<hash>.js`（**双层 assets 是实测的真实产物形状**）/`/favicon.svg` 全 200 且缓存策略按文件性质分（入口 no-store、带哈希 immutable）；预压缩协商在壳路径上生效而 `.gz` 自身不是公开路径（401）；配了壳之后 `GET /v1/cards` 无令牌仍 401、有令牌 200；`POST /index.html` 无令牌 401、有令牌 405；穿越形态与不存在的壳资源都不在精确白名单里（401）；壳目录里混进 `.json`/`.txt`、目录里没有 `index.html`、业务路由登记到壳路径 —— 都**启动即抛错**；`assertShellPathAllowed` 对 `/v1/cards`、`/v1/commands`、`/a0/kill`、`/healthz` 逐条抛错而对壳资源放行；入口表是常量两条且枚举集合只多出静态资源。`edge-ops.test.ts` 4 例见下节。

**测试 8 例**（起真实网关 127.0.0.1 + 临时端口，走真 HTTP）：兑换成功且凭据只能读不能控制；显式要的 `command` 真的签发并能打进命令面；要 `control` 不签发但 `deniedScopes` 如实点名（且打 kill 仍 403）；认不出的平面 400 且配对码不被消耗；同码不可二次使用；未知码/非 POST/坏体各自被明确拒绝；连续失败第 9 次 429；**达到上限后合法码也被挡，窗口过去（用新码）恢复 200**。

**测试写错两次，都值得记**：① 第一版期望"成功后计数清零"能救回合法码 —— 实际是 fail-closed，我把设计选择当成了 bug；② 修完发现恢复不了，因为**配对码 TTL 与失败窗口同为 10 分钟**，推进窗口必然让旧码过期 —— 恢复路径必须用新码。两条都写进了测试注释。

## 未验证项（如实标注）

- **注册表落盘没在真实部署形态下跑过**：本机测试用临时目录（真文件、真权限位、真进程重启），但 systemd 的 `StateDirectory` 归属、三个 uid 与 `ProtectSystem=strict` 下的可写性只在静态层面核对过。
- **注册表文件没有签名/完整性校验**：能写这个文件的人就能签发授权（0600 + edge 独占 uid 就是这里的边界）。逻辑上等价于"拿得到 edge 的 uid 就等于能授权"，本轮不假装它更强。
- **注册表格式只有版本 1**：版本号认不出即拒绝启动，但**没有迁移工具** —— 将来改结构需要人工迁移（先停机、按新版本重写文件）。
- **TLS / 证书未做**：裁决是"仅内网、不设公网入口"，所以本轮是明文 HTTP 跑在回环/内网上；如果部署面变化（跨网段），这一条必须先改。
- **A0 的 kill 语义只到"核心读得到"**：把 kill 接进下单闸门（每次下单前读 `readKillState`）属 P3 的接线，本轮不假装已完成。
- 升级应答（`/a0/ack`）只记录谁答复了，不含真实升级流程。
- ~~**`grantControl` 仍然没有生产入口**~~ **已闭合（2026-10-02）**：入口是 `bin/grant-control.mjs` + edge 的 `--ops-socket` 运维 UDS，见下"运维 control 授予"。
- ~~**设备注册表不落盘**~~ **已闭合（2026-10-02）**：`--device-registry`（必填）指向一个 0600 的注册表文件，只存 `sha256(secret)`、同目录 temp+rename 原子写、损坏即拒绝启动；见上"设备注册表落盘"。
- ~~**撤销（`revoke`）没有 CLI**~~ **已闭合（2026-10-02）**：`bin/revoke-control.mjs` 的两个模式（`--revoke-control` 只收回 control / `--revoke-device` 整台作废）经同一条运维 UDS 落到同一份注册表，见下"运维 control 收回"。
- ~~**驾驶舱静态资源没有归属**~~ **已裁决并落地（2026-10-02）**：§7.4「静态壳 vs 令牌的裁决」给了形态（静态壳免令牌、仅 GET、精确路径白名单、数据一律 Bearer），edge 侧实现见上面"静态壳托管"。仍未做的是**默认托管**：入口不给 `--shell-dir` 就一条静态路径都不开（最小暴露面），部署时要把驾驶舱产物路径显式交给它。
- ~~**业务面路由的作用域声明靠登记方自觉**~~ **已接线（2026-10-02）**：`/v1` 的宿主是 `attachV1Surface`（`packages/tradectl/src/api-v1.ts`），平面逐请求取自 edge 交下来的设备。事实的家在该面的 Note（`2026-10-01-v1-surface-and-static-hosting.md`）。

## 运维 control 授予：`bin/grant-control.mjs` + `--ops-socket`（2026-10-02 补）

`control` **永不默认签发**（配对给的凭据打 `/a0/kill` 一律 403），所以"任何界面一键 kill"
需要一个带外签发动作 —— 它是 `bin/grant-control.mjs`：连 edge 的本地运维 UDS，发一帧
`grant-control`，由 edge 进程里的注册表执行 `grantControl(deviceId)`。

三条 fail-closed 纪律：**注册表不可达即拒绝**（连不上 socket ⇒ 退出码 3，不重试、不降级、
不记待办）；**不接受通配与批量**（`--device` 必须是完整 id，`dev_` + 16 位十六进制，
`*`/逗号列表/半截 id 在发请求**之前**就被拒 ⇒ 退出码 2；这道校验在 CLI 与 edge 两侧各做一次，
通道是边界、边界不信任调用方）；**只做一件事**（没有 `--all`/`--revoke`，未知参数即拒绝）。
`isDeviceId` 是设备 id 形态的家（`edge.ts`），CLI 与运维帧都用它。

**测试 9 例**（`edge-ops.test.ts`：真进程、真 UDS、真 HTTP、无 mock 无 sleep）：一条命令完成签发
（签发前同一凭据 `/a0/kill` 403 → 签发后 200 且 kill 文件的 `reason` 是这台设备）；
注册表不可达 ⇒ 退出码 3；通配/批量/半截 id ⇒ 退出码 2 且**一次都没连过 socket**；
形态合法但注册表里没有 ⇒ `OPS_DEVICE_UNKNOWN`（退出码 4）；撤销见下节。

## 运维 control 收回：`bin/revoke-control.mjs`（2026-10-02 补）

注册表落盘之后，"收回"不再等于"删文件重启 edge"（那会连带作废全部设备），所以撤销是一条
能指名道姓、立刻生效、把结果说清楚的命令：`revoke-control.mjs` 连同一条运维 UDS，按模式发
`revoke-control` 或 `revoke-device` 帧，由注册表执行 `revokeControl(deviceId)` / `revoke(deviceId)`。

**为什么是独立文件而不是 `grant-control --revoke`**：① 授予与撤销在部署面可以是两种角色，
两个二进制才能在文件权限层面分开；② 一个 `--revoke` 布尔量表达不了两种差一个量级的破坏力 ——
"收回 control（其余作用域保留）"与"整台作废（令牌立即失效、必须重新配对）"必须**显式二选一**，
缺模式或两个都给都是退出码 2。`grant-control.mjs` 仍保持"只做一件事"。

| 模式 | 语义 | 成功时打印什么 |
|---|---|---|
| `--revoke-control` | 从 `scopes` 里只摘掉 `control`，其余原样保留；同一凭据 `/a0/kill` 立刻 403、`/a0/status` 仍 200 | `已收回 <id> 的 control；该设备现有平面 ["read","command"]（其余作用域保留）` |
| `--revoke-device` | 整台设备从注册表移除：鉴权 **401**（不是 403）、要回来只能重新配对 | `已作废整台设备 <id>：它的令牌立即失效…` + `注册表还剩 N 台设备` |

**退出码与授予同表**：0 = 撤销真的发生了；2 = 用法 / 通配 / 半截 id（**在发请求之前**就拒，
一次都不连）；3 = 运维通道连不上或超时（不重试、不降级、不记待办）；4 = edge 明确拒绝 ——
`OPS_DEVICE_UNKNOWN`（不在册）或 `OPS_CONTROL_ABSENT`（**本来就没有 control**：什么都没变，
不当成成功；消息里给出它当前的平面，操作者不必再跑一条查询就知道还剩什么）。

**撤销跨重启存活**：两次变更都先落盘再改内存，所以重启后"已收回的 control 不会回来、已作废的
设备不会复活"（`edge-registry-restart.test.ts` 用真进程在同一文件路径上钉住了这一点）。
edge 侧的形态校验在 CLI 与运维帧**各做一次**：通道是边界，边界不信任调用方。

## 被否决的方案

- **cookie 会话**：浏览器自动带凭据 ⇒ 引入 CSRF 面，且与"设备"模型不匹配。
- **把 `grant-control` 做成一条 HTTP 端点**：能授予 control 的设备必须先有 control（死锁），
  所以那条端点必然要免令牌 —— 等于把紧急刹车放到网络面上。改用本地 UDS：谁能碰到 socket
  谁才能授予（文件权限就是这里的边界）。
- **配对即给 control**：见 why 2。
- **kill 只写内存标志**：进程崩了/重启了标志就没了，等于 kill 可以被重启抹掉；改原子文件。
- **A0 复用业务面的鉴权中间件链**：业务面一挂，A0 就一起挂，违背"永不下线"。（A0 与业务面**共用同一道鉴权闸门**不等于共用中间件链：闸门只碰内存注册表，业务 handler 的异常仍只影响自己那条路径。）
- **业务面免鉴权**：曾按"内网所以放过"直连 handler（2026-10-02 验收发现 #2），结果 `/v1` 数据面与命令面对局域网任何进程开放；现改为表外路径一律先鉴权。
- **静默忽略请求里的 `scopes`**：曾把 `POST /pair/redeem` 的 `scopes` 丢掉、永远只发 `read`，客户端以为拿到了 `command`。现改为照签显式平面 + `deniedScopes` 如实回报 + 认不出的平面 400。
- **注册表读不出来时当成空表**：这是最容易写出来的"健壮"写法（`catch { return [] }`），代价是
  全部设备静默失联、且没人知道原因；更糟的是下一次写入会把未知设备永久抹掉。现改为
  **损坏/版本认不出/条目不合规一律拒绝启动**（入口退出码 5），只有"文件不存在"才是空表。
- **注册表先改内存、事后异步落盘**：崩在两次之间就出现"命令报了成功、盘上没有"，
  而撤销恰恰是最不能出现这种偏差的动作。现改为**先落盘再改内存**，写失败即抛错。
- **给 `grant-control.mjs` 加 `--revoke`**：见上"为什么是独立文件"——撤销的两种破坏力
  无法用一个布尔量表达，且授予与撤销在部署面应该是可分权的两个二进制。
- **撤销一个"本来就没有 control"的设备当成功**：那会让退出码 0 同时表示"真的收回了"与
  "什么都没发生"，用它做验收判据等于自欺。现改为 `OPS_CONTROL_ABSENT`（退出码 4）并打印当前平面。
