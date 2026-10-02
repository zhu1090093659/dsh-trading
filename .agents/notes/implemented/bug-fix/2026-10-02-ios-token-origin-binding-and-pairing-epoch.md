# Agent Note: iOS 传输面的取令牌绑定与配对身份（代际）

Status: implemented

## Problem

独立审查报了两条同源的缺陷（Lead 逐处复核过，均为事实）：

1. **令牌跨源外发（最严重）**。`DshtApiClient.request` 先校验目标 origin == 绑定 origin，
   随后调用的是 `tokens.authorization()` —— 一个**不带绑定**的取令牌入口，它不校验这份令牌
   当前绑定在哪个 origin。安全的 `authorization(ifBoundTo:)` 早就写好了，但全仓只有单测在调
   （`CredentialTests`）。同一个 `KeychainTokenProvider` 被所有客户端与配对路径共享，
   于是"为 origin A 创建的客户端"在**重新配对到 B 之后**依然可用：它的 origin 守卫看 URL 仍是 A
   （通过），而 tokens 里已经是 **B 的设备令牌** ⇒ 把 B 的 Bearer 发给了 A。
2. **无重定向 delegate**。`URLSession(configuration:)` 没设 delegate，跨源 30x 被**默认跟随**，
   至少违反"跨源连请求都不发"；令牌是否随重定向被带走取决于 URLSession 行为（**当时未经验证**，
   不作已证泄露的结论）。

两者都属于"安全实现写好了却没接线"：注释与单测都在，生产路径没有走那条路，而且**不报错**。

## 决策

- **取令牌只有一个入口，且必须带绑定**：`TokenProvider.authorization(ifBoundTo:)`。
  无绑定的 `authorization()` **从协议删除**（不是 deprecated、不是改名保留），
  生产代码里再出现它即门禁判红。
- **配对身份 = 绑定 origin + 配对代际（epoch）**：`PairingIdentity`。
  每次配对成功（凭据落库）代际 +1；客户端捕获**创建时**的身份，每次请求前比对，
  不一致 ⇒ `TransportError.stalePairing`，**HTTP 层一次都不调用**。
  origin 只回答"令牌该发给谁"，代际回答"这个客户端还是不是当前那次配对的"——
  没有代际时，"重新配对到**同一个** origin"（重发凭据/换设备）在客户端眼里完全看不出变化。
  epoch 只在进程内递增、不落库、不要求跨重启一致，因此**不进** `StoredCredential` 的编码格式。
- **request 的四道守卫，顺序即语义**：origin → 配对代际 → 取令牌 → 发送。
  顺带覆盖一个真实缺口：路径里**没有**任何读取当前配对令牌的显式入口（`credentialsForCurrentPairing`
  之类），所以"旧客户端框架"只能靠代际拦。
- **跨源 30x 不跟随**：`RedirectPolicyDelegate` 实现 `willPerformHTTPRedirection`；
  跨源（或目标 origin 解析不出来）返回 nil ⇒ URLSession 把**原始 3xx** 交给上层
  （3xx 非 200 ⇒ `ServerFailure` 映射，如实报错）。同源重定向跟随，但返回的是**显式构造的请求**
  （只带方法与请求体，**不重放 Authorization**）——令牌带不带到新地址成为本地可读的事实，
  而不是 URLSession 内部头合并的结果。
- **这一处身份概念同时服务 IOS-7**：跨源缓存污染与令牌跨源外发都收敛到 `PairingIdentity`
  （一个事实只有一个家），IOS-7 复用同一个身份，不另造一份。
- **机检取代注释**：`scripts/ios-native/check-transport-token-binding.mjs` 五条判据进 CI
  （无绑定调用、协议不得再声明无绑定入口、Transport 之外不得取令牌、守卫顺序、重定向 delegate 已挂载），
  与 `wiring-ledger` / `ci-wiring-check` / `patch-id` 冻结面同一立场。

## 事实与证据

- 受影响测试目标：`DshTradingTransportTests`。修复前 **37 例 0 失败**（基线）；
  修复后 **44 例 0 失败**（`apps/ios-native/build/transport-tests.sh`：build-for-testing + simctl spawn xctest）。
- **突变演练真红、恢复真绿**（同一次取证，脚本落在 gitignored 的 `build/`）：
  - A 令牌绑定回退（`ifBoundTo` 不再校验 origin）⇒ 2 例失败
    （`testTokenProviderReleasesTokenOnlyForTheBoundOrigin` 两处 XCTAssertNil 命中）；
  - B 去掉代际守卫 ⇒ 4 例失败（旧客户端负例收到 `unreachable` 而不是 `stalePairing`；
    会话层负例"应当抛出 TransportError，但没有"且 A 上多收到一次 /a0 请求）；
  - C 摘掉 `delegate:` ⇒ 5 例失败（跨源重定向用例：状态 200 vs 302、目标 origin 收到了请求）；
  - 恢复后 **44 例 0 失败**。
- 负例覆盖的正是审查提的三种形态：
  1. 为 A 建 client → 重新配对到 B → 调**旧 A client** ⇒ `stalePairing`，且真服务器 A 上
     **没有任何 /a0 请求**、没有任何含 B 的 deviceId 的请求（B 的 Bearer 没被发去 A）；
  2. 令牌绑定在别的 origin 时 request 抛错，并且真服务器**一个请求都没收到**（不降级成匿名请求）；
  3. 跨源 30x 端点 ⇒ 断言重定向目标 origin **收不到任何请求**，源 origin 只收到最初那一次。
- `check-transport-token-binding.mjs` 自测 9 例（`scripts/ios-native/check-transport-token-binding.test.mjs`）：
  合规绿、无绑定调用红并点名行号、协议重声明无绑定入口红、注释里的 `authorization()` 不误报、
  守卫顺序调换红、URLSession 不传 delegate 红、Transport 之外的层取令牌红、Transport 目录缺失红、
  真仓绿。
- `TransportError` 第二次**只增**：`stalePairing(expected:actual:)`（第一次是 `unauthorized`）。
  `AppEnvironment.TransportSnapshotFetcher.category` 的穷尽 switch 就地补了一行
  （映射到 `.originNotBound`：同样是"要回配对门、不重试"）。

## 被否决 / 已知边界

- **不给无绑定入口留 deprecated 别名**：别名仍然是一个可被调用的取令牌入口，
  而"没有绑定就没有令牌"是这条不变量本身；留别名等于把洞留在原地换个名字。
- **不把 epoch 落库**：它是"本进程发生过几次配对"的计数器；写进凭据编码会让旧格式语义改变，
  而"跨重启仍要一致"没有真实需求（重启后新建的客户端本来就会取到当时的当前代际）。
- **不返回同一份 newRequest 以保留 Authorization**：跨源不跟随（连请求都不发）比"跟随但剥头"
  更强，也没有 URLSession 内部头合并的猜测成分；同源也显式重建请求，代价是重定向后的请求不带
  Authorization —— 未观察到依赖它的端点（`/a0/*`、`/v1/*` 都不做重定向）。
- **不测"令牌曾被带去过跨源目标"**：那个问题已经不存在（跨源不跟随，目标 origin 零请求；
  机检 ⑤ 还挡住有人把 delegate 摘掉），不需要再断言"旧 URLSession 的默认行为是什么"。

## 未验证

- **真机**：本机只在模拟器 + `simctl spawn xctest` 上跑（沙箱挡 `xcodebuild test` 的伪终端，
  与既有做法一致）；真机 Keychain 持久化、后台网络策略未验。
- **HTTPS 与真实中间层**：跨源重定向用例用的是回环 HTTP 与真 HTTP 服务器（零 mock），
  未覆盖 HTTPS 证书/代理/HTTP/2 这类路径上的重定向行为。
- **App 层无单测**：`Sources/App` 没有测试目标，`AppEnvironment` 的代际映射只有编译期保证；
  App 的可执行证据仍是模拟器构建（`scripts/build-simulator.sh`）。
