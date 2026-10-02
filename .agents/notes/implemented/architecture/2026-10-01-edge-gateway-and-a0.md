# edge 网关：唯一网络暴露面、逐设备令牌与 A0「永不下线」

日期：2026-10-01 · 阶段：P2 步骤 4 · 卡片：21b6b892 · 包：`@dshtrading/tradectl/edge`

## 事实

- **只有这一处网络暴露**：`createEdgeGateway` 监听回环或内网接口；`0.0.0.0` / `::` 显式抛错拒绝（那会把执行核变成公网可编程下单端点）。
- **配对与作用域**：一次性配对码（`randomBytes(16)`、TTL 10 分钟、**先消费再校验**——任何一次尝试都不能让同一个码复活）→ 兑换返回设备 id + 明文密钥（只此一次，库里只存 sha256）。作用域 `read` / `command` / `control`（词汇表的家是 `@dshtrading/contract/scopes`，edge 直接引用它的 `grantableByDefault`/`isScopePlane`）：**请求里显式给出的平面照签（read 是底线），`control` 一律剔除**——只能事后由运维 `grantControl` 授予。请求里要了却没签发的平面**不静默吞掉**：响应体的 `deniedScopes` 逐条点名；写了认不出的平面（如 `admin`）⇒ `400 PAIR_SCOPES_INVALID`，且**配对码不被消耗**（参数写错不该烧掉用户的一次性码）。
- **鉴权**：`Authorization: Bearer <deviceId>.<secret>`，`timingSafeEqual` 常数时间比较；**不用 cookie**，所以没有"浏览器自动带凭据"的路径，也就没有 CSRF 面。逐设备 `revoke` 立即生效（没有缓存窗口）。
- **鉴权闸门盖住 A0 与整个业务面**：只有写死在 `PUBLIC_PATHS` 表里的路径（`/pair/redeem`、`/healthz`）在鉴权之前，**表外的一切路径**——A0 六端点、`/v1` 数据面与命令面——都先 `authenticate`，缺令牌/伪造令牌 `401 EDGE_UNAUTHORIZED`，路径存在但 scope 不够 `403 EDGE_SCOPE_REQUIRED`（附 `required`），**鉴权先于 404**（未鉴权的调用方连"哪条路径存在"都不该看出来）。表不按前缀匹配：给某条子路径开口子不等于把整个 `/v1` 放行。
- **业务路由的作用域与设备下发**：`registerBusinessRoutes` 登记时可声明 `requiredScope`（缺省 `read`，命令面路径必须显式声明 `command`）；粒度按**动作**而不是 HTTP 方法——契约的 `ACTION_SCOPE` 里 ack/dismiss 是 read、approve/reject 是 command、kill/flatten 是 control，它们走同一条 POST 路径，动作级判定由 `/v1` 面用 edge 交下来的设备做：handler 的第三个参数就是**已鉴权的设备**（`device.scopes`），宿主据此传 `handleV1`/`createV1Stream` 的 `scopes`，不必自己再解一次令牌。
- **业务路由登记 fail-fast**：登记到公开路径或 A0 路径上直接抛错（那两处永远轮不到业务 handler，静默失效是最难查的一类 bug），声明了不认识的 scope 同样抛错。
- **A0 六端点**：`/a0/ping`、`/a0/status`、`/a0/kill`、`/a0/pause`、`/a0/resume`、`/a0/ack`，在 `createServer` 里**先于**业务面判分支（两者共用同一道鉴权闸门）；kill/pause/resume 要 `control`，其余要 `read`。
- **健康检查 `GET /healthz`**：公开、只回 `{ok, atMs}`，不读注册表、不读 kill 状态、不碰业务面——systemd/监控探针既没有也不该有设备凭据，而探针要能在业务面全挂时照样 200。非 GET/HEAD ⇒ 405。
- **kill 是原子状态**：`writeKillState` 写同目录临时文件再 `rename`（POSIX 同分区 rename 原子），核心每次风险判定都重新 `readKillState`——没有任何缓存能让一次 kill 被"忘记"。

## why（三条关键取舍）

1. **内网不等于可信**：`--host` 只允许回环/内网接口，但仍然逐设备令牌 + 作用域分级。把"在内网"当信任前提，等于让任何能连上内网的东西都能下单。
2. **control 永不默认签发**：它是"停掉一切"的开关。默认发给每个新设备，等于把紧急刹车交出去；所以配对路径里 `control` 被显式过滤，只能由已在册的运维动作 `grantControl` 打开。
3. **A0 先于业务面**：行情挂、agent 挂、账本锁死时，kill 必须仍然生效——所以 A0 只依赖边缘自己的注册表与核心的 kill 文件，业务路由表是分开的 `Map`，业务 404/500 与 A0 完全解耦。

## 测试（`edge.test.ts` 17 例 + `edge-pairing.test.ts` 8 例，全绿）

配对码一次性（二次兑换 UNKNOWN）、过期码被拒（注入时钟推进 11 分钟）、配对默认只给 read 且请求 control 拿不到 + grantControl 后才有、**业务面无令牌 401 / 伪造令牌 401（且 handler 一次都没执行）/ 业务面命令路径 scope 不足 403**、不存在的路径无令牌 401 而有令牌 404、无令牌 401 / 伪造令牌 401 / read 设备打 kill 403（且 kill 未落盘）、撤销即时生效（200 → 401）、响应无 `set-cookie`、**行情面抛错时 kill 仍 200 且原子落盘且核心读得到**、pause 不清 kill 位而 resume 清两位、A0 六端点全 200 且业务 404 不影响、**免鉴权路径表就只有配对与健康检查两条（表里免令牌、表外的 A0 与业务面一律 401）**、健康检查业务面全挂时仍 200 且只收 GET/HEAD、业务路由登记到公开路径/A0 路径即报错、拒绝绑定 0.0.0.0。

**kill 通路全链路（真实设备）**：真实 HTTP `POST /pair/redeem`（显式要 `command`）→ 拿到 `read+command` 凭据 → 业务面 200 但 `/a0/kill` **403**（配对绝不签发 control、kill 文件没被动过）→ 运维 `grantControl` → **同一条凭据 `/a0/kill` 200**，kill 文件里 `reason` 就是这台设备。配对端点侧另有三例：显式要的 `command` 真的签发并能打进命令面、要 `control` 不签发但 `deniedScopes` 如实点名、认不出的平面 400 且码不被消耗。


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

**测试 8 例**（起真实网关 127.0.0.1 + 临时端口，走真 HTTP）：兑换成功且凭据只能读不能控制；显式要的 `command` 真的签发并能打进命令面；要 `control` 不签发但 `deniedScopes` 如实点名（且打 kill 仍 403）；认不出的平面 400 且配对码不被消耗；同码不可二次使用；未知码/非 POST/坏体各自被明确拒绝；连续失败第 9 次 429；**达到上限后合法码也被挡，窗口过去（用新码）恢复 200**。

**测试写错两次，都值得记**：① 第一版期望"成功后计数清零"能救回合法码 —— 实际是 fail-closed，我把设计选择当成了 bug；② 修完发现恢复不了，因为**配对码 TTL 与失败窗口同为 10 分钟**，推进窗口必然让旧码过期 —— 恢复路径必须用新码。两条都写进了测试注释。

## 未验证项（如实标注）

- **设备注册表不落盘**：本轮是内存表，进程重启即全部失效（设备要重新配对）。持久化与"重启后仍需逐设备撤销"属后续步骤。
- **TLS / 证书未做**：裁决是"仅内网、不设公网入口"，所以本轮是明文 HTTP 跑在回环/内网上；如果部署面变化（跨网段），这一条必须先改。
- **A0 的 kill 语义只到"核心读得到"**：把 kill 接进下单闸门（每次下单前读 `readKillState`）属 P3 的接线，本轮不假装已完成。
- 升级应答（`/a0/ack`）只记录谁答复了，不含真实升级流程。
- **`grantControl` 仍然没有生产入口**：`control` 唯一一条来路是运维在注册表上调 `grantControl`，而注册表活在 edge 进程里 —— 仓库里还没有"运维从哪台机器、以什么身份、怎么调它"的入口（契约的 `ACTION_SCOPE` 里 `grant-control`/`revoke-device` 是 `control` 平面的 `/v1` 动作，但要先有第一台 `control` 设备，且 `/v1` 宿主尚未接线）。edge 侧已把设备交给业务 handler，链路的下半段（`/v1` 面把 `device.scopes` 传进 `handleV1` 并按 `ACTION_SCOPE` 判定）**没有实现、也没有宿主**：本轮的"kill 通路可达"只到 edge 边界（测试证明配对 → 运维授予 → kill 200），不代表部署形态下运维已经有了那条入口。
- **驾驶舱静态资源没有归属**：`/v1` 面现在一律要令牌，而浏览器导航（SPA 的 index.html / JS bundle）**带不了 Authorization 头**——设计 §7.4 说网页驾驶舱"由 bot 的 edge 行托管"，那批静态资源的公开与否需要一次设计裁决（独立公开前缀？还是宿主自带静态服务？）。本轮**没有**替它开口子：公开表里就两条，加宽必须显式改表。
- **业务面路由的作用域声明靠登记方自觉**：edge 只看路径、不看请求体，所以"命令面声明 `command`"是登记方的义务；仓库里还没有 `/v1` 宿主进程来履行它（`packages/cockpit/drill/serve.mjs` 那种把 `scopes` 写死成三个平面的 drill 不能当生产宿主）。

## 被否决的方案

- **cookie 会话**：浏览器自动带凭据 ⇒ 引入 CSRF 面，且与"设备"模型不匹配。
- **配对即给 control**：见 why 2。
- **kill 只写内存标志**：进程崩了/重启了标志就没了，等于 kill 可以被重启抹掉；改原子文件。
- **A0 复用业务面的鉴权中间件链**：业务面一挂，A0 就一起挂，违背"永不下线"。（A0 与业务面**共用同一道鉴权闸门**不等于共用中间件链：闸门只碰内存注册表，业务 handler 的异常仍只影响自己那条路径。）
- **业务面免鉴权**：曾按"内网所以放过"直连 handler（2026-10-02 验收发现 #2），结果 `/v1` 数据面与命令面对局域网任何进程开放；现改为表外路径一律先鉴权。
- **静默忽略请求里的 `scopes`**：曾把 `POST /pair/redeem` 的 `scopes` 丢掉、永远只发 `read`，客户端以为拿到了 `command`。现改为照签显式平面 + `deniedScopes` 如实回报 + 认不出的平面 400。
