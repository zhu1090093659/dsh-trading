# @dshtrading/client-ui-special-indicators

## Unreleased

### Minor Changes

- agent 工具面：四组特殊指标（IF/IM 期现基差、A 股恐慌指数、恒科前十大权重股卖空、板块融资余额）进模型上下文，
  新增五只只读工具——`special_indicators_get_snapshot`（group 可选 basis|sentiment|hk_short|sectors）、
  `special_indicators_get_sentiment_history`（days 30..800）、`special_indicators_get_sector_ranking`（window 1..120 / limit ≤60）、
  `special_indicators_get_sector_series`（code 白名单 + days 10..500）、`special_indicators_get_hk_short_top10`（limit ≤10）。

  - **同一取数实例**：工具与 `/dshtrading/api/special-indicators` 桥共用 apply() 里那个 FinanceClient——同一 TTL/落盘缓存、
    in-flight 去重、SWR 陈旧回源、同一凭据链（逐请求惰性解析）。白名单子路由、参数夹取与缓存档抽到 src/routes.ts，
    桥与工具面同源，不新增第二份取数逻辑、不读 cache.json 当数据源。注册形态照 connector-jin10：
    `defineTool` + `createSpecialIndicatorTools(client, config)` + apply 内 `ctx.inject(['tools'])`（同名先到先得）。
  - **只读**：仅 GET 白名单子路由，无下单/撤单/改参/改台账能力，不动原桥 auth 栅栏。
  - **出参信封**：`as_of`（本次读数 ISO）、`expected_data_date`（上游有则原样透传；无则用 payload 日期派生并标
    `expected_data_date_source`；派生不出就省略并留 note）、`stale`（上游声明优先，否则按「数据日 < 应有数据日」派生）、
    `cache_stale`（桥缓存档返回过期条目，与数据面滞后分开）、`stale_source`（写明依据）、`source`（自有 finance 服务 + 上游路径）。
  - **不可用 ≠ 空数据**：上游失败/凭据缺失/路由拒绝一律抛错，文案带 FinanceError 的 code 并写明「没拿到数据」，
    绝不返回空列表；数组类出参超限带 `truncated: true`。
  - 新增 peerDependency `@deepseek-ai/dsh-tools`（与其它 30 个插件包同款；不声明会让 tsdown 把 host SDK 相对化内联进 lib）。
  - 测试：test/indicator-tools.test.ts（28 例，BDD 命名、零 mock/零 sleep，含 apply 组装面「工具面与桥共用同一缓存」实证）。

## 0.6.1

### Patch Changes

- @dshtrading/dsh-home@0.6.1

## 0.6.0

### Patch Changes

- 8901682: 桥缓存落盘：宿主重启后首个请求直接命中，不再每次冷拉上游。

  成因：内存 TTL 缓存随宿主进程退出清零，而浏览器侧缓存按 origin 隔离——桌面壳每次启动挑随机空闲端口，origin 一变上个会话的 sessionStorage/localStorage 整片成孤儿，于是「重启一次 = 冷拉一次」。

  - FinanceClient 新增 persistence 注入端口（load 同步补水 / save 异步原子写），落盘到 $DSH_HOME/special-indicators/cache.json：v1 信封 + baseUrl 指纹（换过上游地址即判废）、条目保留写入时刻（跨进程继续按同一 TTL 判定陈旧）、7 天保鲜期（覆盖周末与长假）、256 条上限（板块明细按代码分键防无界增长）；读写失败一律静默降级为慢。
  - 新增 Config.cacheFile（空 = 默认路径）；新增依赖 @dshtrading/dsh-home。

- 189f5e9: 特殊指标：修正「数据滞后」徽标语义与容器边缘自适应。

  - 滞后判据改为「上游数据日 vs 预期数据日」：T+1 指标在交易日显示上一交易日数据不再误标滞后；桥 SWR 缓存标记不再驱动徽标（基差撤掉徽标，恒科只认上游自身 stale）。
  - 板块双栏/单栏断点由视口宽（@media）改为中栏实际宽（@container）：会话侧栏展开/关闭时布局跟随；卡片补 box-sizing: border-box，消除 26px 右缘越界与横向滚动条。
  - @dshtrading/dsh-home@0.6.0

## 0.5.0

### Minor Changes

- DSH 宿主 cohort 前移到 `0.2.0-rc.2`，新增银河星耀数智 A 股数据源，并收口一批客户端图表与适配缺陷。

  - `@dshtrading/base`：宿主 floor 与内置面随 official cohort 前移（移除 0.1.7 失效的内置插件，
    改用原生面；role presets 迁到 agent-preset registry 运行时注册）。
  - `@dshtrading/connector-xysz`：接入银河星耀数智（AmazingData/tgw）A 股数据源，含真实网络
    原始响应证据与健康/品种/K 线/盘口数据面。
  - `@dshtrading/client-ui-trading`：会话寻址与草稿附件 API 适配官方面；副图 legend 下漂修复。
  - `@dshtrading/client-ui-settings`：适配 configForms 与 locale 合并的宿主迁移。
  - `@dshtrading/client-ui-special-indicators`：拉数据不再整屏清空（桥 SWR 陈旧回源 + 面板缓存优先）、
    图表铺满中栏并移除宽度上限、图例移出绘图区。
  - `@dshtrading/knowledge`：作者字段跨平台归一（别名表 + 入库/写盘/读盘三处接线）。

## 0.4.1

### Patch Changes

- 私有插件并入 fixed 组版本流：桌面 vendor 闭包与增量更新载荷硬校验所有打包包版本等于 release tag（pack-update-payload），changesets ignore 使其停在 0.1.0 并令 v0.4.0 mac 构建失败。版本随家族演进，保持 private 不发布（publish-npm 跳过 private）。
