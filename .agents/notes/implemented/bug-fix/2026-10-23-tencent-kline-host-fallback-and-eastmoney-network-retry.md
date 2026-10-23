# Agent Note: 腾讯 K 线域名被 WAF 封死后的回退链与东财请求通道的有界重试/熔断

Status: implemented

## Problem

2026-10-23 桌面壳行情页 K 线加载失败。定性原因两条，都在取数客户端里：

- **腾讯日/周/月 K 的域名被上游 WAF 封死**。`connector-tencent` 原先只打
  `https://web.ifzq.gtimg.cn/appstock/app/{fqkline,hkfqkline}/get`，该域名对任何标的、任何周期、
  任何 UA/Referer/HTTP 版本都回 HTTP 501 + `waf.tencent.com/501page.html` 挑战页；绕开本机代理
  直连真实 IP（`183.47.126.125` / `183.47.104.102`）仍是同一页。同族域名
  `https://ifzq.gtimg.cn` 同参数返回 200 且 payload 结构一致（`qfqday`/`qfqweek`），
  分钟线用的 `/appstock/app/kline/mkline` 本来就在这个域名上。
- **东财 `requestJson` 既不重试也没有单枪超时**。`push2his.eastmoney.com` 的请求时成时空回（同一
  URL 连打里夹着 `curl: (52) Empty reply from server` / undici `fetch failed`（`UND_ERR_SOCKET`），
  紧接下一枪又 200）：首次网络级失败直接抛 `TRADING_NETWORK: fetch failed`，一次抖动就等于一次
  取数失败；`fetch` 调用没有 `signal`，请求挂住就没有任何上界。当时的归因写成「东财边缘抖动」，
  该归因已被 2026-10-23 二次实测推翻（见 Decision 首段）。

原始证据（2026-10-23 10:00 CST，本机实测）：

```
$ curl -sS -m 20 -D - 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz001201,day,,,5,qfq'
HTTP/2 501
server: stgw
date: Fri, 23 Oct 2026 02:00:54 GMT
content-length: 326

<!DOCTYPE html><html><head><script>var i=location.href;var v=window.btoa?window.btoa(window.encodeURIComponent(i)):"";window.location.href="https://waf.tencent.com/501page.html?u="+location.origin+"&id=28ac14bb37a816267c4a41fcb82ef0a5-1782978139862606-436-140193557792512-40986759625355050&st=03&v="+v;</script></head></html>

# 直连真实 IP 复现（绕开本机代理）
$ curl -sS -m 20 --resolve web.ifzq.gtimg.cn:443:183.47.126.125 \
    -w 'http=%{http_code} remote=%{remote_ip}\n' \
    'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz001201,day,,,5,qfq'
http=501 remote=183.47.126.125

# 同族域名同参数
$ curl -sS -m 20 -w 'http=%{http_code} bytes=%{size_download}\n' \
    'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz001201,day,,,5,qfq'
http=200 bytes=1938
{"code":0,"msg":"","data":{"sz001201":{"qfqday":[["2026-10-16","13.720","14.130","14.530","13.570","90661.000"],["2026-10-19","14.400","14.060","14.560","13.840","71824.000"],...
```

```
# 东财 kline/get 连打 5 次，全为空回（curl (52) / undici UND_ERR_SOCKET）
attempt 1: curl: (52) Empty reply from server   http=000 bytes=0
...
attempt 5: curl: (52) Empty reply from server   http=000 bytes=0
$ node -e 'fetch(klineUrl)...'   → attempt 1 err fetch failed UND_ERR_SOCKET
$ node --dns-result-order=ipv4first -e 'fetch(klineUrl)...'
attempt 1 status 200 len 362   {"rc":0,...,"data":{"code":"001201","market":0,"name":"东瑞股份",...
attempt 2 err fetch failed UND_ERR_SOCKET
attempt 3 status 200 len 362
```

## Decision

2026-10-23 二次实测（16 枪、低频有界探针）推翻了「重试一枪就够」的旧口径：

- 最长连败 6 枪跨 22.7 秒，恢复一次后 19.3 秒再度失败——单次立即重试落在这类窗口里就是继续失败；
- 失败形态是「连接已建立之后的 HTTP 空回」：connect 均 3 ms 级成功、total 0.15-0.31 s、
  `curl (52) Empty reply from server`、`http=000 bytes=0`。不是 connect 失败、不是超时；
- 同刻 push2（非 his）三枪也全空回，腾讯两枪 200；
- `remote_ip` 全是 `198.18.0.167` = 本机代理 fake-ip（系统代理 `127.0.0.1:7890`，三个公共解析器
  一致）。故「东财边缘抖动」无证据支持，看到的是**代理链路空回**，东财边缘在失败时刻的行为
  未验证；这也解释了「换东财主机/换域名」为何无用（push2 与 push2his 同刻一起空回）。

1. **日/周/月 K 的域名回退链**（`connector-tencent` 的 `DEFAULT_KLINE_BASE_URLS`）：
   `https://ifzq.gtimg.cn` → `https://web.ifzq.gtimg.cn`，有序、最多两级、串行、同 param 同 count
   同超时，每级各打一次，不无限重试。分钟线继续单域名走 `mklineBaseUrl`（本就落在同族域名上，
   不参与回退）。
2. **注入即取代整条链**：`TencentRestOptions.klineBaseUrl` 注入时链长为 1，只用该 base，不掺默认
   域名——测试/反代场景下不会突然有一枪打到公网。
3. **只有三类失败换域名**：网络级失败（含超时）、HTTP 5xx、非 JSON（WAF 挑战页/HTML 错误页）。
   429 保留 `TRADING_RATE_LIMITED`、4xx 保留 `TRADING_EXCHANGE_ERROR`，`code!=0` 与
   「无行」这类业务错误一律就地 fail-closed，不用第二级域名掩盖。链走完仍失败时错误消息补一句
   `all kline hosts failed (<chain>); last: <最后一枪原文>`，便于把事故直接归因到链上哪一级。
4. **东财请求通道：有界重试 + 单枪超时 + 按主机短期熔断**（`EastmoneyRestClient` 的
   `requestOnce`/`requestJson`）：
   - `requestOnce` 仍是单次 GET+JSON 并返回可重试标记；新增 `timeoutMs` 单枪超时（默认 2000 ms），
     口径照 `connector-tencent` 的 `#fetchWithTimeout` 但**盖满整枪**：建连、响应头与**响应体解析**
     合成一个 `attempt` promise 与超时 `Promise.race`，到点以 `TRADING_NETWORK` +
     `request timed out after <n>ms` 终结该枪且 `retryable=true`，定时器在 `finally` 里撤销。
     只给 fetch 调用挂定时器是不够的：`fetch` 一 resolve 定时器就撤，`res.json()` 随即无上界；
     而 abort 打的是本实例自己造的 `controller`，对**已经返回的** `Response` 的 body 读取不保证
     生效（注入的 `fetchImpl` 更是完全不理会），所以必须由实现自己把「取数与响应体解析」整体
     与超时竞速——「200 头已到、body 永不结束」因此同样受 3 枪上界与整通硬截止约束。
   - 只有网络级可重试失败才重试，硬上界 **3 枪**；重试之间是**固定 200 ms** 冷却（不是退避、不递增）。
   - 一次取数整通有 **3000 ms 硬截止**（含冷却与全部枪）：单枪超时取「单枪超时与剩余预算」的小值，
     冷却必须整段装进剩余预算，装不下就收尾——枪数与整通耗时都有硬上界，到点即放弃剩余枪，不续命。
   - 整通网络级失败后把**该主机**记进 **30000 ms 熔断窗口**。粒度按 host（push2 / push2his /
     searchapi / datacenter-web 各自独立：按 host 是最小诚实的粒度，数据中心接口不被行情故障
     连坐）。窗口内对该主机的调用**零网络请求**、立即抛 `TRADING_NETWORK`，消息写明
     `circuit open, <n>ms remaining`（错误码不变，下游路由照旧按网络故障判定）；到期自动恢复，
     任一成功即清零（在飞的兄弟请求成功可推翻另一请求刚打开的窗口）。
   - HTTP 非 2xx 与 JSON 解析失败维持不可重试，且**不打开**熔断（一个 404/WAF 页不是主机故障）。
   - 冷却与整通截止都读注入式时钟 `EastmoneyClock`（`now()`/`sleep(ms)`，缺省真实 timer，与
     熔断器同在 `src/resilience.ts`），单测据此断言被请求的时长而不真等。

## Verification & Gates

- `pnpm --filter @dshtrading/connector-tencent test`：73 例全绿（含新增 6 例：501 挑战页回落到链尾、
  200 回 HTML（非 JSON）回落、两级都失败时消息可辨且只打两枪、注入 base 时链长为 1、
  `code!=0` 不回落、429 不回落）。
- `pnpm --filter @dshtrading/connector-eastmoney test`：76 例全绿。重试/熔断面共 12 例：
  3 例改写存量（首枪空回 → 冷却后第二枪成功、trends2 同形、连续失败时枪数硬上界三枪且冷却固定
  200 ms），2 例改写存量（HTTP 500 / HTML 页不重试、不冷却，且随后一次照常打枪证明没开熔断），
  7 例新增（整通在假时钟下不超过 3 s 硬截止且第三枪不打、fetch 本身挂住时被单枪超时 abort 成
  `TRADING_NETWORK`、**200 头已回但 body 永不结束**时同样在单枪超时内终结并受 3 枪上界约束、
  熔断窗口内零请求且消息带 `circuit open` 与剩余毫秒、窗口到期自动恢复打枪、在飞的成功清零熔断、
  行情主机熔断不影响 searchapi）。报价降级派生的存量断言同步为「三枪 ulist + 一枪 trends2」，
  且第二轮取价因 push2 熔断为**零请求**。
- `pnpm test:audit`：通过（无新增测试债；模板用例文件零违规）。
- `node node_modules/typescript/bin/tsc --noEmit -p packages/connector-eastmoney/tsconfig.json`：
  8 条诊断 = `scripts/typecheck-baseline.json` 既有基线（`mapIntervalToKlt`/`parseIntervalMs`
  的返回与 `getKlines` 的 `parts[]` 索引），本次改动零新增。
- 真实网络复跑（跑完删除的临时脚本，注入计数 `fetchImpl`、真实时钟，3 次调用间隔 2.2 s，
  总枪数 3）：
  ```
  [call1] error code=TRADING_NETWORK message=Eastmoney network error: fetch failed elapsed=1044ms
  [call2] error code=TRADING_NETWORK message=Eastmoney push2his.eastmoney.com: circuit open, 27799ms remaining elapsed=0ms
  [call3] error code=TRADING_NETWORK message=Eastmoney push2his.eastmoney.com: circuit open, 25597ms remaining elapsed=0ms
  --- shots ---
  t=+1ms took=190ms ok=false err=fetch failed
  t=+392ms took=217ms ok=false err=fetch failed
  t=+810ms took=234ms ok=false err=fetch failed
  total shots = 3
  ```
  即：本轮上游仍在空回，第一通打满 3 枪、两段固定 200 ms 冷却、整通 1044 ms 后按
  `TRADING_NETWORK` 收尾并打开熔断；随后两次调用命中熔断，零请求、0 ms 返回且消息带剩余毫秒。
  故障态下的耗时上界与零请求都成立。
- 全量门禁（`pnpm -r test` / `gates:all` / `typecheck-gate` 全配置）未在本变更内跑，按重活串行纪律
  由提交侧统一执行；本节列出的是本变更自己跑过的包级证据。
- 本机 DNS 观察（环境事实，非代码行为）：本机解析器对 `push2his.eastmoney.com` 同时给
  `198.18.0.167`(A) 与 `2001:2::4`(AAAA)，两者都是代理 fake-ip；空回与解析顺序无关，调整
  IPv4/IPv6 优先序不改变失败形态。

## Alternatives considered

- **一次立即重试就够**（2026-10-23 旧口径，本变更推翻）：实测连败 6 枪跨 22.7 秒，两枪都落在
  同一故障窗口内的概率很高；改为有界 3 枪 + 固定冷却 + 整通硬截止，并在持续故障时用 30 s 熔断
  把「每次取数都等满 3 枪」压到零请求。
- **按 5xx/网络错误无限次重试或加退避**：桌面壳 8 s 一拍的侧栏会把抖动放大成上游压力；退避还会让
  单次取数的上界取决于失败次数，与本变更「枪数与耗时都有硬上界」相悖。
- **东财内部换主机/换域名**（push2 ↔ push2his）：实测两主机同刻一起空回，换了没用。
- **按 IPv6/IPv4 解析顺序或 DNS 参数做文章**：空回发生在连接建立之后（connect 3 ms 级成功），
  归因指向代理链路；换解析顺序无证据支持。
- **把熔断做成全局（不按主机）**：行情域故障会连坐数据中心报表接口（港股通持股），
  而两者的可用性无关。
- **把东财重试做成配置开关**：没有第二个使用场景，YAGNI。
- **跨源回退（腾讯挂 → 东财/雅虎）**：被
  [报价 fail-closed 与禁跨源回退](../simplification/2026-10-15-connector-quote-fail-closed-no-cross-source-fallback.md)
  的既定裁决否决，且会把单次取数变成多源串联、延迟与语义都不可控。

## Consequences

- 日/周/月 K 在链首域名可用时只多花一次 DNS/TLS（同一域名，无额外请求）；链首 501/空回时多一枪、
  多一次超时上限的耗时，属故障态代价。
- 东财任一取数在网络级失败时最多打 3 枪（每枪带 2 s 超时）、夹两段固定 200 ms 冷却，整通不超过
  3 s；持续故障时该主机进入 30 s 熔断，后续调用零请求失败——上游压力与调用方等待同时被压住。
- 报价降级派生路径的第一轮变成「3 枪 ulist + 一枪 trends2」，30 s 内第二轮起 ulist 零请求
  （push2 熔断），trends2 仍走 push2his 自己的熔断状态；降级链的请求量闸门（`DERIVED_QUOTE_TTL_MS`）
  不变。
- 熔断按实例持有，同一进程里的 cn/hk 两个实例互不共享窗口；跨进程不做协同（本仓无第二处消费）。
- 依赖「链尾域名将来会不会换一个 WAF 页」「代理链路何时恢复」这类上游变化仍只能靠实测发现，
  本变更不引入健康探测或持久化缓存。

参见 [腾讯分钟线与动态符号](../feature/2026-08-31-tencent-minute-klines-and-dynamic-symbols.md)
（mkline 域名与 param 形态）与 [东财报价路径降级派生](../feature/2026-10-14-quote-path-degradation.md)
（降级态的请求量闸门）。
