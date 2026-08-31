# Spike 证据：腾讯分钟 K 线端点可达性（2026-08-31）

## 结论

**可达**。此前"端点本出口不可达"结论过时（connector-tencent rest.ts 头注）——
当时用的 host/参数形态不对。正确形态：

- 端点：`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=<wire>,m5,,<count>`
  - host 是 **ifzq.gtimg.cn（无 www.）**；带 www. 的 kline/mkline 返回 301
  - param 形态：`<wire>,m5,,<count>`（**没有 qfq 段**——加 qfq 报 bad params 的
    是 fqkline；mkline 参数只有四段）
  - 周期词汇：m5 / m15 / m30 / m60
- 实测响应（sh600519, m5, 3 根）：

```json
{"code":0,"msg":"","data":{"sh600519":{"m5":[
  ["202608281450","1295.50","1296.17","1296.30","1295.50","445.00",{},"0.36"],
  ["202608281455","1295.98","1297.12","1297.33","1295.98","663.00",{},"0.53"],
  ["202608281500","1297.11","1297.40","1297.89","1297.10","734.00",{},"0.59"]],
  "prec":"1292.30"}}}
```

## 行结构

`[YYYYMMDDHHmm, open, close, high, low, volume, 附加对象(可丢), 涨跌幅]`
——字段序与 fqkline 一致（**开收高低量**），但时间格式不同（数字 YYYYMMDDHHmm，
非日期字符串），解析需独立的时间转换（按 Asia/Shanghai 墙钟）。

## 附带可达发现

- `appstock/app/minute/query?code=sh600519` 分时序列也可达
  （data.data: ["0930 1289.00 81 10440900.00", ...] 分时价/量）——分时图素材。

## 实现 spec（issue 承接）

1. api：`Interval` 增加 `5m` / `30m`（15m/1h 已有；30m 为新增词汇）。
2. connector-tencent：`getKlines` 分钟分支走 mkline 端点 + YYYYMMDDHHmm 解析 +
   跌回证据用例。
3. 其他 connector：binance/okx 原生支持 5m/30m，补 BAR 映射；yahoo/stooq 视端点
   决定支持面或报 UNSUPPORTED_INTERVAL。
4. GUI：间隔栏加 5分/30分（locale + interval 数组）。
