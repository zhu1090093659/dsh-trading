# 自持契约包：id 冻结面、版本协商、scope 三平面

日期：2026-10-01 · 阶段：P4 步骤 1 · 卡片：bf92b5d2 · 包：`@dshtrading/contract`（零第三方依赖）

## 事实

- **自持而不是复用官方 Typert wire**（卡片裁决）：移动端的信任面是"设备 + 可撤销令牌"，而 Typert 的信任面是同源浏览器会话（无法按设备撤销）；把 App 发布节奏绑到 DSH cohort 上也会让"官方升级"与"App 能用"变成同一件事。
- **id 冻结面**（ids.ts）：`clientRequestId` 可见（幂等键，客户端要能带它重试）；**`clientOrderId` 永不可见** —— 它能被用来绕开核心直接对 venue 讲话（很多交易所支持按它撤单/查询），一旦下发，执行核的限额/mandate/风险闸门就都建立在"只有核心能对 venue 讲话"之上的假设就破了；`orderId = ord_ + UUID` **只比较不解析**、一律 factory 生成；`venueOrderId` 只是字段、永不作句柄。
- **唯一下发路径**：`toClientOrderView()` 是唯一把内部订单投影给客户端的函数（`clientOrderId` 在这里被丢掉，想加回来必须改它，而不是某个调用点顺手带上）；`assertNoClientOrderId()` 做下发前最后一道闸，递归抓任意层级的夹带（含数组）。
- **版本策略**（version.ts）：major 进 URL；minor 只增不减；`X-Dsht-Caps` 求交集；缺必填能力或超出 **N-2** 窗口 ⇒ `426 CLIENT_TOO_OLD`（明确要求升级，而不是静默降级成残缺渲染）；比服务端新 ⇒ `CLIENT_TOO_NEW`。
- **scope 三平面**（scopes.ts）：`grantableByDefault()` 无论请求怎么写都剔除 `control`；输出按声明顺序（稳定顺序是契约的一部分）。

## CI 门禁：`pnpm contract-id:check`

`scripts/contract-id-gate.mjs` 扫描全仓源码，禁止出现匹配 `ord_[0-9a-f]{8}-[0-9a-f]{4}-4` 的**写死字面量**。理由：契约是"只比较不解析"，一旦某处写死或解析，它就获得了语义，接着有人依赖这个语义——改格式就成破坏性变更。例外只有两处：契约包的 factory/正则自身，以及测试里带 `id-gate-allow` 标注的故意样本。

**门禁的自测放在契约包里**（`packages/contract/test/id-gate.test.ts`）而不是 `scripts/`：伪造样本与它的标注规则放在同一个包里，规则才不容易被绕过；样本本身用**运行期拼接**构造，于是门禁扫自身测试文件时不会误报（这条是被门禁自己抓出来的——第一版把字面量直接写在测试里，门禁准确地把测试文件报成了违规）。

## 测试（15 例全绿）

orderId 形态与"只比较不解析"（无 venue slug、前缀后就是 UUID）、`isOrderId` 拒绝四种伪形态、投影后无 `clientOrderId` 且有 `clientRequestId`、`assertNoClientOrderId` 抓嵌套/数组并指出路径、协商放行与交集、缺能力/超 N-2/过新三种 426、N-2 窗口内放行、caps 头解析往返稳定、control 永不默认签发、`isScopePlane` 只认三平面；外加门禁四条自测。纯函数，无 mock 无 sleep。

## 未验证项（如实标注）

- **HTTP/WS 传输层未实现**：本步只落地契约的数据面（id/版本/scope 与门禁），一元写、WS 单向下行、journal 游标补页的**服务端实现**属后续步骤。
- **与 P2 edge 的 scope 词汇尚未合并**：两处各有一份 `read/command/control`（契约包是线上面权威、tradectl/edge 是执行面实现）。合并需要跨包改造，**另开一次变更**；在那之前两边若漂移，只能靠 review 发现——已记为待办。
- **N-2 兼容只有单元断言**，没有真实旧客户端的联调证据。

## 被否决的方案

- **复用官方 Typert wire**：见事实第一条（信任面与发布节奏两条都不成立）。
- **把 `clientOrderId` 一并下发**：等于给客户端一把绕开核心的钥匙。
- **从 `orderId` 里编码信息**（如 venue 前缀）：那会让"只比较"变成"可解析"，格式从此不能改。
- **缺能力时静默降级渲染**：客户端会看到一个残缺但"看起来正常"的界面——426 明确要求升级更诚实。
