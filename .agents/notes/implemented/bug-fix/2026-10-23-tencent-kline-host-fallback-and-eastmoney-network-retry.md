# Agent Note: 腾讯 K 线域名被 WAF 封死后的回退链与东财网络级重试

Status: implemented

## Problem

2026-10-23 桌面壳行情页 K 线加载失败。定性原因两条，都在取数客户端里：

- **腾讯日/周/月 K 的域名被上游 WAF 封死**。`connector-tencent` 原先只打
  `https://web.ifzq.gtimg.cn/appstock/app/{fqkline,hkfqkline}/get`，该域名对任何标的、任何周期、
  任何 UA/Referer/HTTP 版本都回 HTTP 501 + `waf.tencent.com/501page.html` 挑战页；绕开本机代理
  直连真实 IP（`183.47.126.125` / `183.47.104.102`）仍是同一页。同族域名
  `https://ifzq.gtimg.cn` 同参数返回 200 且 payload 结构一致（`qfqday`/`qfqweek`），
  分钟线用的 `/appstock/app/kline/mkline` 本来就在这个域名上。
- **东财 `requestJson` 不重试**。`push2his.eastmoney.com` 属边缘抖动：同一 URL 连打里夹着
  `curl: (52) Empty reply from server` / undici `fetch failed`（`UND_ERR_SOCKET`），紧接下一枪又
  200。首次网络级失败直接抛 `TRADING_NETWORK: fetch failed`，一次抖动就等于一次取数失败。

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
4. **东财网络级重试一次**（`EastmoneyRestClient.requestJson`）：单次 GET+JSON 抽成
   `requestOnce` 并返回可重试标记，只有 fetch 抛出的网络级异常（含 undici `fetch failed`/空回）
   立即重试一枪；HTTP 非 2xx 与 JSON 解析失败不重试。无 sleep、无定时器、无退避，最多两枪。
   kline/get 与 trends2 共用这条通道，一次抖动不再等于一次失败。

## Verification & Gates

- `pnpm --filter @dshtrading/connector-tencent test`：73 例全绿（含新增 6 例：501 挑战页回落到链尾、
  200 回 HTML（非 JSON）回落、两级都失败时消息可辨且只打两枪、注入 base 时链长为 1、
  `code!=0` 不回落、429 不回落）。
- `pnpm --filter @dshtrading/connector-eastmoney test`：69 例全绿（含新增 5 例：kline 首枪网络级失败
  → 第二枪成功、trends2 首枪空回 → 第二枪成功、HTTP 500 不重试、非 JSON 不重试、
  连续失败时请求量有界为两枪）。
- `pnpm test:audit`：通过（无新增测试债）。
- 真实网络复跑（跑完删除的临时脚本，消费 `lib/` 构建产物）：
  ```
  [tencent] requests = 1 https://ifzq.gtimg.cn
  [tencent] rows = 751   # 请求 750 根，上游按 count+1 回（既有行为，未改）
  [tencent] first = 2023-09-12T00:00:00.000Z  {"open":23.4,"high":24.08,"low":23.4,"close":23.86,...}
  [tencent] last  = 2026-10-23T00:00:00.000Z  {"open":15.39,"high":15.72,"low":15.15,"close":15.52,...}
                                                # 末根是当日盘中未收盘那根，两趟复跑 close 会变
  [eastmoney] requests = 2 / 1                  # 两趟复跑：一趟第一枪空回、重试那枪拿到 5 根；
                                                # 另一趟不抖动，一枪到底。两种都正常返回 rows = 5
  [eastmoney] rows = 5
  [dead-host] code = TRADING_EXCHANGE_ERROR    # 注入被 WAF 封死的域名：只打一枪，501 原样上报
  [dead-host] message = Tencent https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?...: HTTP 501 Not Implemented
  [dead-host] requests = 1
  ```
- 本机 DNS 观察（环境事实，非代码行为）：本机解析器对 `push2his.eastmoney.com` 同时给
  `198.18.0.167`(A) 与 `2001:2::4`(AAAA)，node 默认 verbatim 顺序下 IPv6 那一枪容易先失败
  （`UND_ERR_SOCKET`）；加 `--dns-result-order=ipv4first` 后同一次探测只花一枪。
  这解释了上表中东财两枪与一枪的差异，重试逻辑本身与 DNS 顺序无关。

## Alternatives considered

- **把 `web.ifzq` 直接从代码里删掉、只留 `ifzq`**：WAF 封的是域名而不是服务，同族域名互为
  备份的成本只有一次串行请求；直接删掉等于把「换一个域名就能恢复」的余量也删了。
- **跨源回退（腾讯挂 → 东财/雅虎）**：被
  [报价 fail-closed 与禁跨源回退](../simplification/2026-10-15-connector-quote-fail-closed-no-cross-source-fallback.md)
  的既定裁决否决，且会把单次取数变成多源串联、延迟与语义都不可控。
- **按 5xx/网络错误无限次重试或加退避**：桌面壳 8s 一拍的侧栏会把抖动放大成上游压力；一次立即重试
  只覆盖「空回/单次断连」这种瞬时形态，够了。
- **把东财重试做成配置开关**：没有第二个使用场景，YAGNI。

## Consequences

- 日/周/月 K 在链首域名可用时只多花一次 DNS/TLS（同一域名，无额外请求）；链首 501/空回时多一枪、
  多一次超时上限的耗时，属故障态代价。
- 东财任一请求在网络级失败时会多发一枪；报价降级派生路径因此变成「两枪 ulist + 一枪 trends2」
  （测试已按新口径断言请求量有界）。
- 依赖「链尾域名将来会不会换一个 WAF 页」这类上游变化仍只能靠实测发现，本变更不引入健康探测或缓存。

参见 [腾讯分钟线与动态符号](../feature/2026-08-31-tencent-minute-klines-and-dynamic-symbols.md)
（mkline 域名与 param 形态）与 [东财报价路径降级派生](../feature/2026-10-14-quote-path-degradation.md)
（降级态的请求量闸门）。
