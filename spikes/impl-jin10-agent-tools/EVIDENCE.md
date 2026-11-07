# 金十 agent 工具面缺口补齐 现场取证（B 交付证据）

两处改动：
1. `flash_list` 增加可选参数 `hot`（热度过滤）；
2. 新增工具 `macro_rates`（央行利率）。

## 0. 复现命令

```bash
cd /Users/zcl/code/.worktrees/dsh-trading/ft-dp-kdas-jin10
pnpm --filter @dshtrading/connector-jin10 build
node spikes/impl-jin10-agent-tools/run.mjs > /tmp/jin10-evidence.json
```

`run.mjs` 跑生产代码（`connector-jin10/lib/service.js` + `tools.js`）打**真实网络**：
热度快讯走网页版公开快讯接口、利率走网页版公开利率接口——两者都不需要金十 MCP Token，
所以能在不读取 profile 密钥的前提下真跑（凭证路径由既有测试与代码路径覆盖，见 §4）。

## 1. 工具面（改动后）

`flash_list`、`flash_search`、`news_list`、`news_search`、`news_get`、`econ_calendar`、`macro_rates`、`global_instruments`、`global_quote`、`global_klines`

## 2. `flash_list` 带 hot（真实返回）

### 2.1 `hot=火,热,沸,爆`（全量页，20 条；下面贴页头与 5 条样本，原文照抄）

```text
flash_list (hot=火/热/沸/爆) — 20 item(s) from a fixed 47-item upstream page, newest-first, source: Jin10 (金十数据) web flash endpoint (public heat-filtered feed):
2026-10-15T12:57:25.000Z | 新华传媒：10月16日复牌，重组审计评估尚在进行 | https://flash.jin10.com/detail/20261015205725179800 | hot=火
2026-10-15T12:40:09.000Z | 通胀压力持续升温 美国9月PPI数据大幅走高 | https://flash.jin10.com/detail/20261015204009005800 | hot=爆
2026-10-15T12:32:24.000Z | 现货黄金短线下挫24美元，现报4143.36美元/盎司 | https://flash.jin10.com/detail/20261015203224024800 | hot=火
2026-10-15T12:31:18.000Z | 美国PPI、零售销售数据均超市场预期 | https://flash.jin10.com/detail/20261015203118588800 | hot=爆
2026-10-15T12:30:10.000Z | <b>美国9月PPI月率 1.3%，预期0.50%，前值由0.40%修正为0.5% | https://flash.jin10.com/detail/20261015203010324800 | hot=火
```

### 2.2 `hot=热,爆 & limit=3`（本地截断，页头如实回带上游页大小 48）

```text
flash_list (hot=热/爆) — 3 item(s) from a fixed 48-item upstream page, newest-first, source: Jin10 (金十数据) web flash endpoint (public heat-filtered feed):
2026-10-15T12:40:09.000Z | 通胀压力持续升温 美国9月PPI数据大幅走高 | https://flash.jin10.com/detail/20261015204009005800 | hot=爆
2026-10-15T12:31:18.000Z | 美国PPI、零售销售数据均超市场预期 | https://flash.jin10.com/detail/20261015203118588800 | hot=爆
2026-10-15T12:30:10.000Z | <b>美国9月PPI年率 6.3%，预期5.3%，前值由5.40%修正为5.6% | https://flash.jin10.com/detail/20261015203010318800 | hot=热
has_more=false — no further pages.
```

### 2.3 `hot=烫`（非法词汇：显式报错并列出支持值）

```text
ERROR: flash_list: unsupported hot level "烫" (supported: 火/热/沸/爆; comma-separated for several)
```

### 2.4 不给 hot（零回归：仍走 MCP 全量流）

```text
ERROR TRADING_CREDENTIALS_MISSING: jin10 mcp initialize: missing MCP token. 配置金十 MCP Token：设置中心 dshtrading.credentials.jin10.token，或环境变量 JIN10_MCP_TOKEN。
```

说明：本次本机 env 与 profile 都未提供金十 MCP Token，所以 2.4 一步真跑时被凭证闸门拦下
（`TRADING_CREDENTIALS_MISSING`）——这正是既有语义，本改动没有触碰该路径（`hot` 缺席时
走的还是原来那一行 `service.listFlash`，由既有用例守着）。热度的"不给 hot 就完全一致"由
单测覆盖：`packages/connector-jin10/test/agent-tools-hot-rates.test.ts` 断言不给 hot 时
只调 MCP `list_flash` 且出参不含 `hot=`。

## 3. `macro_rates`（真实返回）

### 3.1 全量（30 家央行，原始返回）

```json
{
 "source": "Jin10 (金十数据) web rate board (public interest-rate endpoint behind rili.jin10.com)",
 "unit": "percent per year (publisher raw string)",
 "as_of": "2026-10-15T13:07:48.337Z",
 "snapshot_at": null,
 "snapshot_note": "The publisher returns a latest-value snapshot with no snapshot timestamp in the contract; each row carries its own publishedAt (publication date of that rate).",
 "region": null,
 "available_regions": [
  "中国",
  "丹麦",
  "乌克兰",
  "以色列",
  "俄罗斯",
  "加拿大",
  "匈牙利",
  "南非",
  "印度",
  "印度尼西亚",
  "哥伦比亚",
  "土耳其",
  "墨西哥",
  "尼日利亚",
  "巴西",
  "挪威",
  "捷克",
  "新西兰",
  "日本",
  "智利",
  "欧元区",
  "波兰",
  "泰国",
  "澳大利亚",
  "瑞士",
  "罗马尼亚",
  "美国",
  "英国",
  "菲律宾",
  "韩国"
 ],
 "total": 30,
 "count": 30,
 "items": [
  {
   "region": "欧元区",
   "bankName": "欧洲央行",
   "rate": "2.5",
   "publishedAt": "2026-09-10",
   "indicatorName": "欧洲央行存款机制利率"
  },
  {
   "region": "美国",
   "bankName": "美国联邦储备局",
   "rate": "4",
   "publishedAt": "2026-09-17",
   "indicatorName": "美联储利率决定(上限)"
  },
  {
   "region": "中国",
   "bankName": "中国人民银行",
   "rate": "3",
   "publishedAt": "2025-05-20",
   "indicatorName": "一年期贷款市场报价利率"
  },
  {
   "region": "英国",
   "bankName": "英国央行",
   "rate": "3.75",
   "publishedAt": "2025-12-18",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "日本",
   "bankName": "日本央行",
   "rate": "1.25",
   "publishedAt": "2026-09-18",
   "indicatorName": "央行目标利率（上限）"
  },
  {
   "region": "加拿大",
   "bankName": "加拿大央行",
   "rate": "2.25",
   "publishedAt": "2025-10-29",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "瑞士",
   "bankName": "瑞士央行",
   "rate": "0",
   "publishedAt": "2025-06-19",
   "indicatorName": "央行政策利率"
  },
  {
   "region": "澳大利亚",
   "bankName": "澳洲联储",
   "rate": "4.6",
   "publishedAt": "2026-09-29",
   "indicatorName": "澳洲联储利率决定"
  },
  {
   "region": "新西兰",
   "bankName": "新西兰联储",
   "rate": "2.75",
   "publishedAt": "2026-09-02",
   "indicatorName": "联储利率决定"
  },
  {
   "region": "韩国",
   "bankName": "韩国央行",
   "rate": "3",
   "publishedAt": "2026-08-27",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "俄罗斯",
   "bankName": "俄罗斯央行",
   "rate": "14",
   "publishedAt": "2026-07-24",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "印度",
   "bankName": "印度储备银行",
   "rate": "5.5",
   "publishedAt": "2026-10-07",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "泰国",
   "bankName": "泰国央行",
   "rate": "1",
   "publishedAt": "2026-02-25",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "土耳其",
   "bankName": "土耳其央行",
   "rate": "37",
   "publishedAt": "2026-01-22",
   "indicatorName": "一周回购利率"
  },
  {
   "region": "挪威",
   "bankName": "挪威央行",
   "rate": "4.5",
   "publishedAt": "2026-09-24",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "菲律宾",
   "bankName": "菲律宾央行",
   "rate": "5",
   "publishedAt": "2026-08-27",
   "indicatorName": "央行政策利率"
  },
  {
   "region": "巴西",
   "bankName": "巴西央行",
   "rate": "13.75",
   "publishedAt": "2026-09-17",
   "indicatorName": "Selic利率"
  },
  {
   "region": "墨西哥",
   "bankName": "墨西哥央行",
   "rate": "6.5",
   "publishedAt": "2026-05-08",
   "indicatorName": "央行利率决定"
  },
  {
   "region": "南非",
   "bankName": "南非央行",
   "rate": "7.25",
   "publishedAt": "2026-09-23",
   "indicatorName": "回购利率"
  },
  {
   "region": "丹麦",
   "bankName": "丹麦国民银行",
   "rate": "1.6",
   "publishedAt": "2025-06-05"
  },
  {
   "region": "以色列",
   "bankName": "以色列央行",
   "rate": "3.75",
   "publishedAt": "2026-05-25"
  },
  {
   "region": "印度尼西亚",
   "bankName": "印尼央行",
   "rate": "5.75",
   "publishedAt": "2026-06-18",
   "indicatorName": "7天逆回购利率"
  },
  {
   "region": "匈牙利",
   "bankName": "匈牙利国民银行",
   "rate": "6.25",
   "publishedAt": "2026-02-24"
  },
  {
   "region": "捷克",
   "bankName": "捷克国民银行",
   "rate": "3.5",
   "publishedAt": "2025-05-07"
  },
  {
   "region": "乌克兰",
   "bankName": "乌克兰国民银行",
   "rate": "16",
   "publishedAt": "2026-09-17",
   "indicatorName": "央行利率"
  },
  {
   "region": "哥伦比亚",
   "bankName": "哥伦比亚央行",
   "rate": "11.25",
   "publishedAt": "2026-04-02"
  },
  {
   "region": "尼日利亚",
   "bankName": "尼日利亚央行",
   "rate": "26.5",
   "publishedAt": "2026-02-24"
  },
  {
   "region": "罗马尼亚",
   "bankName": "罗马尼亚国民银行",
   "rate": "6.5",
   "publishedAt": "2024-08-07"
  },
  {
   "region": "波兰",
   "bankName": "波兰国民银行",
   "rate": "3.75",
   "publishedAt": "2026-03-04"
  },
  {
   "region": "智利",
   "bankName": "智利央行",
   "rate": "5",
   "publishedAt": "2024-12-18",
   "indicatorName": "央行基准利率"
  }
 ]
}
```

### 3.2 `region=美国`（命中）

```json
{
 "source": "Jin10 (金十数据) web rate board (public interest-rate endpoint behind rili.jin10.com)",
 "unit": "percent per year (publisher raw string)",
 "as_of": "2026-10-15T13:07:48.389Z",
 "snapshot_at": null,
 "snapshot_note": "The publisher returns a latest-value snapshot with no snapshot timestamp in the contract; each row carries its own publishedAt (publication date of that rate).",
 "region": "美国",
 "available_regions": [
  "中国",
  "丹麦",
  "乌克兰",
  "以色列",
  "俄罗斯",
  "加拿大",
  "匈牙利",
  "南非",
  "印度",
  "印度尼西亚",
  "哥伦比亚",
  "土耳其",
  "墨西哥",
  "尼日利亚",
  "巴西",
  "挪威",
  "捷克",
  "新西兰",
  "日本",
  "智利",
  "欧元区",
  "波兰",
  "泰国",
  "澳大利亚",
  "瑞士",
  "罗马尼亚",
  "美国",
  "英国",
  "菲律宾",
  "韩国"
 ],
 "total": 30,
 "count": 1,
 "items": [
  {
   "region": "美国",
   "bankName": "美国联邦储备局",
   "rate": "4",
   "publishedAt": "2026-09-17",
   "indicatorName": "美联储利率决定(上限)"
  }
 ]
}
```

### 3.3 `region=火星`（未命中：空列表 + 可用地区，**不是**失败）

```json
{
 "source": "Jin10 (金十数据) web rate board (public interest-rate endpoint behind rili.jin10.com)",
 "unit": "percent per year (publisher raw string)",
 "as_of": "2026-10-15T13:07:48.439Z",
 "snapshot_at": null,
 "snapshot_note": "The publisher returns a latest-value snapshot with no snapshot timestamp in the contract; each row carries its own publishedAt (publication date of that rate).",
 "region": "火星",
 "available_regions": [
  "中国",
  "丹麦",
  "乌克兰",
  "以色列",
  "俄罗斯",
  "加拿大",
  "匈牙利",
  "南非",
  "印度",
  "印度尼西亚",
  "哥伦比亚",
  "土耳其",
  "墨西哥",
  "尼日利亚",
  "巴西",
  "挪威",
  "捷克",
  "新西兰",
  "日本",
  "智利",
  "欧元区",
  "波兰",
  "泰国",
  "澳大利亚",
  "瑞士",
  "罗马尼亚",
  "美国",
  "英国",
  "菲律宾",
  "韩国"
 ],
 "total": 30,
 "count": 0,
 "items": []
}
```

## 4. 口径声明（与实现一致）

- **数据源**：热度快讯 = 金十网页版公开快讯接口（`3318fc…\.z3c.jin10.com/flash`）；央行利率 =
  金十日历网页版公开利率接口（`e0430d…\.z3c.jin10.com/web/interest_rates`，即 rili.jin10.com 背后
  的接口）。两者都**不是**官方 MCP feed——描述与出参按实际取数面写，出参 `source` 字段同源。
- **单位**：利率为**年化百分比**，保留上游原样字符串（`"4"` / `"2.5"` / `"0"`），不做数值化、
  不换算成小数。
- **时间口径**：上游是"最新值快照"且契约里没有快照时间；出参给 `as_of`（本次调用时刻）、
  `snapshot_at: null` 与 `snapshot_note`，每行另带该央行自己的 `publishedAt`（公布日）。
- **失败语义**：上游 HTTP 错误 / 非 JSON / 业务 `status != 200` **抛错**（连接器译成
  `TRADING_EXCHANGE_ERROR`）；空列表只代表"这次真的没有匹配"，绝不代替"上游不可用"。
- **凭证**：本条读取不需要金十 MCP Token。

## 5. 门禁命令与结果

```bash
pnpm --filter @dshtrading/connector-jin10 build   # ✔ Build complete
pnpm --filter @dshtrading/connector-jin10 test    # Test Files 11 passed / Tests 102 passed（含新增 7 例）
pnpm -r build && node scripts/typecheck-gate.mjs  # 72 个 tsconfig，总错误数 371（基线 387）→ ✓ 未超基线
pnpm test:audit                                   # 测试卫生门禁：通过（无新增测试债）
node scripts/tool-contract-gate.mjs --update      # flash_list 参数表新增 hot；macro_rates 显式登记（T5）
```

新增测试：`packages/connector-jin10/test/agent-tools-hot-rates.test.ts`
（7 例：BDD 标题带角色前缀、0 mock（注入 fetchImpl 普通函数替身）、0 sleep）。
既有两处工具面清单断言（`test/tools.test.ts` / `test/plugin.test.ts`）随新增工具同步更新为 10 个。

## 6. 缺口与未验证项

1. **MCP 半（不给 hot）未做真实网络取证**：本机无金十 MCP Token（env 未设、profile 未配），
   该路径本次只由既有测试与未改动的代码路径覆盖；热度路径（本次交付的主体）已真实取证。
2. **热度页的 `has_more` 语义沿用上游"满页即还有"判断**（`pageFooter` 由既有实现给出），
   本次样本页未满，未验证翻页边界；边界由 `web-flash.test.ts` 的满页用例覆盖。
3. **`limit` 在热度路径是本地截断**，不是上游参数（上游该接口无 limit）；出参页头显式写明
   "fixed N-item upstream page"，避免把本地截断读成上游就给了这么多。
