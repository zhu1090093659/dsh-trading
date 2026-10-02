# /v1 面与静态资源托管：协商在前、取数在后，未知枚举的卡片不丢只禁用

日期：2026-10-01 · 阶段：P4 步骤 3（服务端一半）· 卡片：bf92b5d2 · 包：`@dshtrading/tradectl/api-v1`

## 事实

- **每个请求都协商**（`X-Dsht-Caps` + 426），不是只在握手时做一次：会话是长命的，能力在升级窗口里会变。**顺序先协商再取数**——能力不够时不该先把数据读出来再丢掉。
- **卡片下发**：`GET /vN/cards` 返回卡片页 + `caps`（交集）+ `downgraded`（客户端没有的服务端能力）+ `truncated`；分页受契约包的 `maxCardsPerPage` 约束；`cache-control: no-store`（卡片是易变数据）。
- **未知枚举的卡片以"不可操作形态"下发，不是丢弃**（`operable: false` + `actions: []` + 保留 `fallbackText` 与内容）：丢掉会让用户以为"没有这条数据"，而实际是"你的客户端看不懂它"——后者可以靠升级解决，前者会让人误判事实。
- **静态资源由 edge 自己托管**（不引 dsh 的 webserver 行）：目录遍历被拒（解析后的绝对路径必须仍在根内）、扩展名白名单（不做 MIME 嗅探）、`index.html` 不缓存而带哈希的资源长缓存。
- `attachV1Surface(register, options)` 复用 P2 的 edge 路由注册口，于是"唯一网络暴露 + A0 永远在线"这两条既有性质对新面自动成立。

## 测试（9 例新增，tradectl 累计 130 例全绿）

版本化路径解析与裸路径 404；缺必填能力 ⇒ 426 且**不返回任何卡片**（顺序断言的落点）；协商通过回 caps 交集与降级项 + no-store；非 GET 405；**未知枚举卡片不可操作但仍下发（内容与兜底文本都在）**；分页 + truncated；白名单 content-type 与两种缓存策略；目录遍历 403 / 白名单外 415 / 缺文件 404；`/v1/assets/` 在配了 staticDir 时 200、未配时 404。真文件（临时目录）+ 纯函数，无 mock 无 sleep。


## 后续补齐：scope 判定接进 /v1（2026-10-01 同日）

原文记的"scope 校验尚未接进 /v1"已补上。判定顺序现在是：**版本/能力协商 → scope 判定 → 取数**，每一步失败都不碰数据。

- 面配置新增 `scopes`（由 edge 从设备令牌解析后传入）与 `requiredPlane`（缺省 `read`）。
- **为什么不在这一层解析令牌**：令牌校验只有一处归属（edge），这里只做**授权判定** —— 两处都解析就变成两个事实之家，而"谁是这台设备"一旦有两个答案，撤销就会失效。
- 拒绝形态是 `403 SCOPE_REQUIRED` + `required` + `granted`（如实回已持有的平面，便于排查，同时不下发任何数据）。
- **静态资源同样受判**：换成 `/v1/assets/` 不能绕过授权（测试专门盯这一点 —— 资源路径最常见的漏洞就是"以为是免检通道"）。

测试补 3 例：只有 command 平面 ⇒ 403 且不返回卡片；持 read ⇒ 200、空 scope ⇒ 403；持 control 的设备取静态资源同样 403。tradectl 累计 **134 例全绿**。


## 一元写的幂等登记（P4 步骤 3 写路径前置，同日补）

`createIdempotencyLedger` 三条规则：

1. **同一 clientRequestId 携带不同载荷 ⇒ 冲突拒绝，绝不重放旧结果** —— 重放等于把一个完全不同的意图当成"已经办过了"，这是幂等设计里最容易被忽略也最危险的一条。
2. **只有完成态可重放**；在途返回 in-flight；失败态直接删记录（允许重试，且不留下"办过一半"的痕迹）。
3. **账有界**：TTL + 条数上限，丢最旧的；清理是**显式策略**（`sweep()` 报清理条数），不是"内存压力到了就丢"。

**指纹前先做载荷规范化**（递归按键排序）：JSON 的键序在语义上无关，但 `JSON.stringify` 对键序敏感 —— 不规范化的话，客户端把同样的请求写成 `{a,b}` 与 `{b,a}` 会被判成"同一个键配不同载荷"而遭冲突拒绝，幂等判定随之失去意义。（这条是写测试时发现的：第一版测试标题声称"对键顺序稳定"，而实现其实敏感 —— **标题比实现更强**，于是改实现而不是改标题。）

测试 6 例：fresh → in-flight → replay；同键不同载荷冲突且不泄露旧结果；失败后可重试；TTL 过期后键可复用；条数上限丢最旧；键序无关（含嵌套对象）。tradectl 累计 **140 例全绿**。


## 写命令端点 POST /vN/commands（同日补）

顺序有意固定为 **scope（按动作）→ 幂等登记 → 执行 → 回执检查**，每一步失败都不执行：

- 动作到平面的映射来自契约包的 `ACTION_SCOPE`（`kill/pause/flatten` 属 control，`approve/reject` 属 command，`ack` 属 read）⇒ 没持有该平面就 `403 SCOPE_REQUIRED` 且**执行核一次没被碰**（测试断言 `calls.length === 0`）。
- 幂等键冲突在**执行之前**判掉，否则就成了"先做了再说"。
- **回执检查（fail-closed）**：执行结果先过契约包的 `assertNoClientOrderId`；夹带 `clientOrderId` 的结果被判 `500 LEAKY_RESULT` 并**扣下不下发**，同时把幂等键标记失败（不留"已成功"的假记录）。这条是 id 冻结面在写路径上的落点。
- 执行核抛错 ⇒ `502` 且幂等键删除（允许重试）；请求体超上限 ⇒ `413`；缺幂等键/未知动作/畸形体 ⇒ `400`。
- **同步 core + async 包装**：GET 走 `handleV1`（纯计算，不返回 Promise），POST 走 `handleV1Async` —— 把读写混成一个 Promise 会让所有读路径的调用方被迫 await。

测试 7 例：执行一次且 replayed=false；重放不重复执行；同键不同载荷 409 且不执行；control 类动作缺平面 403 且不执行；未知动作/缺键/畸形体 400 且不执行；**回执夹带 clientOrderId 判失败并扣下**；执行抛错 502 且键可重试。tradectl 累计 **147 例全绿**。


## WS 单向下行 + journal 游标补页（同日补完，服务端收尾）

三条立场：

1. **单向下行**：服务端只推、不接业务消息。客户端想说什么是写端点的事（`POST /v1/commands`）—— 一条既推又收的连接会让授权边界变成一团浆糊（"谁能在这条连接上做什么"会随消息类型变化）。测试里客户端发一条 `{action: kill}` 只会得到 `ignored`。
2. **游标补页而不是"从当前开始"**：`?cursor=N` 就从 N 续推；**不带游标才从 `latestSeq` 开始** —— "只要新的"必须由客户端显式选择，两者的语义不能混。
3. **游标过期 ⇒ resync 帧，绝不静默跳跃**：journal 保留窗口裁掉旧事件后，落后太多的客户端拿不到续读；这时下发 `{type:'resync', snapshotSeq, state}` 并**从快照续读**。静默从最新开始会让客户端以为自己没漏东西 —— 那是最坏的一种"看起来正常"。

另有 `maxBatch` 背压（慢客户端不拖垮服务端）与 `SCOPE_REQUIRED` 错误帧（缺 read 平面时**一个事件都不推**就关闭）。

测试 6 例：带游标续推且 seq 严格递增；不带游标只推新事件；**游标过期 ⇒ resync + 从快照续读且不重复推旧 seq**；单向下行下客户端消息一律 ignored；缺 read 平面 ⇒ 只发 error 帧并关闭；maxBatch 限制每轮帧数。tradectl 累计 **153 例全绿**。

## 宿主接线：平面只能来自设备（2026-10-02 补）

`attachV1Surface(register, options)` 从"挂一条 `/v1` 的 drill 口"变成**真实宿主**：它接受 edge 的
`BusinessRouteRegistrar`（第三参数是已鉴权设备），登记 `/v<major>/cards`（read）与
`/v<major>/commands`（下限 read），并**逐请求**把 `device.scopes` 传进 `handleV1`/`handleV1Async`。
契约上不给宿主持有一份平面的机会：宿主配置类型是 `V1HostOptions = Omit<V1SurfaceOptions,'scopes'>`
——留一个可传入的 `scopes` 就是留一条"宿主写死三个平面"的路（`packages/cockpit/drill/serve.mjs`
正是那样写的），而那种形态下**撤销一台设备后它的令牌在 edge 那层失效、宿主里那份平面却仍然
让每个请求有全部权限**。

**命令面在路径层的作用域下限是 read，不是 command**（订正 F2 的一处注释）：`POST /v1/commands`
上的动作横跨三个平面（`ACTION_SCOPE`：ack/dismiss 是 read、approve/reject 是 command、
kill/flatten/grant-control 是 control），而 edge 只看路径、不看请求体。在这一层声明 command 会把
read 类动作对只有 read 的设备变成 403 —— 而那正是"我能看到这条升级"与"我要不要批准它"的分界。
三个平面的权威判定在**动作级**（`handleCommand` 逐动作查 `ACTION_SCOPE`，缺平面回
`403 SCOPE_REQUIRED` + `required` + `granted`）。

**每台设备一份面对象（`WeakMap<Device, V1SurfaceOptions>`）**：命令面的幂等账挂在 options 的
**对象身份**上（`ledgerFor` 用 WeakMap 取账），逐请求 `{...options}` 会让每个请求拿到一本空账
—— 同一个 `clientRequestId` 重放会**再执行一次**且没有任何报错。按设备建对象顺带把账按客户端分开
（两台设备的同号请求不再互相判冲突），设备对象被换掉或回收时旧账随之消失。

**下行流同样只能由已鉴权设备建**：`createV1StreamForDevice(device, options)`（`stream-v1.ts`）
把 `scopes` 钉死在设备上，会话多一个 `deviceId`；缺平面时拒绝帧带 `required`
（`{type:'error',code:'SCOPE_REQUIRED',required:'read'}`）。下行是有状态的长连接，宿主自带一份
`scopes` 的后果比一次请求严重得多（撤销后那条连接还能继续推持仓与决策）。

**测试 5 例**（`api-v1-host.test.ts`：真 edge、真 HTTP、真设备令牌，无 mock 无 sleep）：
卡片面用设备的平面取数（配对设备 200、伪造令牌 401、撤销后同一令牌立刻 401）；
命令面按 ACTION_SCOPE 逐动作判平面（read 设备 ack 200 且执行核只被调用一次；approve 403
`required=command`、kill 403 `required=control`，两条的 `granted` 都如实回 `["read"]` —— 宿主若
自带一份三平面，这里会显示三个平面）；显式授予 control 后同一个 kill 动作 200；
同一 `clientRequestId` 经宿主重放 `replayed=true` 且执行核只被调用一次；
只有 command 平面的设备连不上下行流（只发带 `required` 的拒绝帧、一个事件都不推），
持 read 的设备经宿主拿到事件帧且会话带 `deviceId`。

## 未验证项（如实标注）

- ~~SPA 本体未做~~ **已做**：React/Vite 独立 SPA 与 ui-screenshot-verify 截图在 `@dshtrading/cockpit`，事实的家是 `2026-10-01-cockpit-spa-skeleton.md`。本面仍保留 `/v1/assets/**` 的**鉴权**静态分支（面自己的托管口，drill 与 API 客户端用它）；**免令牌的静态壳**由 edge 托管（§7.4 裁决，见 edge 的 Note）。
- ~~写路径未实现~~ **一元写端点与 WS 单向下行都已就绪**（见下两节）；服务端三件套（读面 / 写面 / 下行面）齐了。
- ~~scope 校验尚未接进 /v1~~ **已接入**（协商 → scope → 取数）**且写路径是动作级判定**（`handleCommand` 查 `ACTION_SCOPE`）；平面逐请求来自 edge 交下来的设备（见"宿主接线"）。
- **静态托管还没有 ETag**（条件请求未做）；压缩已做（gzip + br 预压缩协商），**真实网络下的收益仍未测**。

## 被否决的方案

- **先取数再协商**：白读一遍数据，且在数据量大时会把"客户端太旧"变成一次昂贵的失败。
- **未知枚举的卡片直接丢弃**：用户会以为没这条数据（见事实第三条）。
- **静态资源交给 dsh 的 webserver 行**：那行在全局必需集里，bot 面要能在没有它的环境里跑（P2 已裁决）。
