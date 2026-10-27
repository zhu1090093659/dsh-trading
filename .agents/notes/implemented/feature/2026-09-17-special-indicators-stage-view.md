# Agent Note: 特殊指标中栏视图（本地私有插件 client-ui-special-indicators）

Status: implemented

## Problem

用户自有 finance 服务（/Users/zcl/code/finance，经 nginx Basic 认证暴露在
finance.chatwithai.icu）长期产出四组**区别于行情指标**的专有指标：IF/IM 期现基差、
A 股恐慌指数（方法学版本可配，默认 v3）、恒科前十大权重股卖空、板块融资余额。这些指标此前只能在
finance 自带的看盘网页查看，交易终端（中栏）没有入口；用户要求与「策略」「知识库」
同级新增「特殊指标」tab，且插件**不公开发布**、只挂载本机 profile。

## Decision

- **独立插件包** `packages/client-ui-special-indicators`
  （`@dshtrading/client-ui-special-indicators`）：`private: true` +
  `license: UNLICENSED`，并进 `.changeset/config.json` `ignore`——fixed 族
  版本联动与 `changeset publish` 都不触及它。**不进 `@dshtrading/base`
  的 dependencies 与 cordis.patch.yml**：base 是已发布 bundle，依赖一个永不发布的
  包会让 base 的 npm 发布直接断裂（workspace:^ 转版本号后 npm 无此包）。
- **挂载面 = profile 级**（indicator-supertrend 同款先例）：trading-web profile 的
  package.json `file:` 依赖 + pnpm-workspace.yaml overrides 行 +
  profile `cordis.patch.yml` insert 行。仓库内零 base 接线，卸载 = 删行。
- **host 半 = 白名单代理桥** `/dshtrading/api/special-indicators`：
  - 固定 9 条只读子路由（status + 四组指标的快照/历史/排行/明细），**非通用代理**；
    查询参数服务端夹取（days 10–500 等），板块代码白名单正则防路径注入。
  - browser-auth 栅栏与 updater/行情桥同款（connection.requestRejection）；
    未认证流量零穿透到自有服务。
  - 凭据链逐请求惰性解析：设置中心 `credentials.finance` → 行配置 password →
    环境变量 `FINANCE_API_PASSWORD` 兜底；**仓库不内置密钥**（密码只落本机
    profile 文件，不进 git）。401 映射 FINANCE_AUTH_FAILED 且不自动重试
    （docs/api.md 纪律）。
  - 内存 TTL 缓存（快照 60s/历史 300s）+ in-flight 去重 + 陈旧回源
    （SWR，2026-09-18：窗口外请求立即回陈旧值 + 后台再验证，失败保留
    陈旧值；信封带 stale 标记）：nginx 每客户端 10 req/s 限流下的好公民；
    失败不写缓存。详见 [特殊指标拉数据不再整屏清空](../bug-fix/2026-09-18-special-indicators-swr-cached-first.md)。
- **client 半 = 中栏 tab**（tradingStageViews.register，id
  `special-indicators`、order 30 于知识库之后）：**二级页签布局，每个页签
  一组指标**（用户 2026-09-17 评审意见：一屏通览改逐组展示）——恐慌指数
  （大分数 + 五档色签 + 分项条形 + 与中证全指双轴叠加的 250 日面积图）、
  基差（IF/IM 双统计块 + 基差率双线图）、恒科卖空（聚合占比 + 双轴历史 +
  成分股表）、板块融资（20 日变化率排行表 + **选中板块双轴历史图**）。
  页签选择持久化 localStorage（`dshtrading.special-indicators.tab.v1`，与
  MiddleStage 同款契约；jsdom 无 Storage 面时 try/catch 静默降级）。
  - **恐慌指数方法学版本可配**（2026-10-15）：finance 端 v1/v2/v3 并列可切换
    （v2 = 七槽等权；v3 = v2 + 融资连增连减，八槽全有效才出分），路由不再写死
    `methodology=2`，改由配置面 `sentimentMethodology`（默认 **3**）同时驱动快照与
    历史两条路由——同一会话内必须固定同一个方法，历史序列不得一半 v2 一半 v3
    （docs/api.md 纪律）。卡片副标题里的版本号**从载荷的 `methodology_version`
    取**，不再写死在词典里：方法换了而标签还写着旧版本，比不写更糟。越界配置值
    如实透传给上游（finance 返回 422），本地不做夹取、也不静默改口径。
  数据**页签按需加载**（2026-09-17 优化）：status 握手后只拉当前页签的
  两个端点（首屏数据请求 8→2），页签首访拉取、回访命中已加载集零网络，
  手动刷新重拉全部已加载页签（未访问页签不预拉）；allSettled 面板隔离
  不变。**面板数据持久化 sessionStorage**（2026-09-18：`dshtrading.special-
  indicators.dash.v1`，重挂载缓存先上屏 + 后台再验证平滑换新，失败面板
  不覆盖已有数据面板，详见 bug-fix 链接同上）。上游 null/滞后如实呈现
  不补零（docs/api.md「错误处理」纪律）。
  - **代码面懒加载**（2026-09-17 优化）：tradingStageViews 注册的 render
    经 `LazySpecialIndicatorsView`（React.lazy + 自带 Suspense 边界，
    MiddleStage 上方无边界）动态 import 视图本体——视图 +
    lightweight-charts（bundle 源体积 ~65%，sourcemap 实测 189KB/248KB）
    推迟到 tab 首访才执行。tsdown client 配置加 `inlineDynamicImports`：
    rolldown 把动态 chunk 折叠为 init_* 惰性函数留在单文件内（ModuleLoader
    只认识单文件 client.js，分 chunk 的相对 require 无法解析）。实测
    factory 热身执行 0.13ms→0.02ms（node 模拟面；lwc 模块体以声明为主，
    激活期绝对收益小，价值在结构上与首访前的零图表代码执行）。
  - **图表重建治理**（2026-09-17 优化）：四张卡片 series 数组改 useMemo
    （deps=数据引用+t）——LineChart 以 series 引用变化为整图重建信号，
    此前板块行点击（setSelected 重渲染）会让 300 点×2 序列的明细图无数据
    变化销毁重建；memo 后重建收敛到数据真正更新时。
  - **板块明细图**（2026-09-17 追加，对齐 finance 页面布局）：左排行表、
    右侧选中板块的融资余额面积（亿元，rzye/1e8）+ 板块指数双轴折线
    （/sectors/detail → /api/v2/sectors/{code}，days=300）；缺省选中排行
    第一名，点击行切换；明细请求带序号闸丢弃过期响应，快速连点不串图。
- **shell 改动面 insert-only**：client-ui-trading 词典加 `stage.special`
  （zh 特殊指标 / en Special）一键——中栏 tab 条文案由 shell 的 t 渲染，
  第三方视图包的 titleKey 必须落在 shell 词典（tradingStageViews 契约）。
- **i18n 边界**：本包**不进** dsh-i18n 中心语言包（published）与
  i18n-audit 的 PACKAGES——那会给已发布 dsh-i18n 引入对私有包的 workspace
  依赖。zh-CN 用户经宿主 fallback 链（zh-CN → zh）命中本包自注册的 zh 词典，
  功能无缺口；zh/en 键集合 + 占位符对齐由包内 test/locale-contract.test.ts
  钉住（口径与 i18n-audit 相同）；CJK 扫描覆盖全仓 src/client 与 PACKAGES
  名单无关，本包自动在门禁内。

## Alternatives considered

- **继续把方法学版本写死在路由里。** 放弃（2026-10-15 复核）：写死等于每次换版本
  都要改代码 + 重新构建 + 刷新 profile 副本 + 重启宿主；改配置面后换版本只动 profile
  一行。默认取 v3 是因为用户要看的是 finance 侧新交付的第八槽（融资连增连减）。
- **前端同时展示两种方法（并排 v2/v3）。** 放弃：两个总分并排会让读者在没有对照口径
  的情况下比大小；finance 自己的看板也是单选（`sentimentMethodology`），保持一致。
- **本地夹取越界的方法学值（如配成 9 就回落 2/3）。** 放弃：静默回落会把配置错误变成
  一个看起来正常的读数。透传给上游由 finance 的 422 显式拒绝，错误留在日志与响应里。
- **把版本号继续写在词典文案里（只改数字）。** 放弃：那只是把「写死的 v2」换成
  「写死的 v3」，下一次切版本又会错标；版本本来就是载荷字段，应当从载荷读。

- **base 内嵌行（随公开包分发）**：违背「不公开发布」要求，且会让 base 的
  npm 发布依赖一个不存在的包，直接否掉。
- **client 半直连 finance.chatwithai.icu（无 host 桥）**：跨域 + Basic 凭据
  进浏览器 fetch 会让密码暴露在前端代码/存储面；且 finance nginx 未配 CORS。
  桥形态凭据永不出 host 进程。
- **通用 /proxy?path= 转发**：一处配置错误即把带凭据代理变成开放转发器；
  白名单子路由把攻击面收敛到九条只读路径。
- **加入 dsh-i18n 中心语言包**：published 包依赖 private 包会让 changeset
  发布面断裂（见 Decision）；fallback 链已覆盖 zh-CN，无功能收益。

## Consequences

- 恐慌指数卡片默认展示 finance 的 **v3**（2026-10-15 起）：八个分项槽位、副标题显示
  「方法 v3」。要回退 v2：在 profile 行配置里写 `sentimentMethodology: 2`（改配置即可，
  无需改代码或重建）。
- v3 要求八槽全有效才出总分；某一槽缺数据的日子卡片会显示「数据不足」，而同一时刻 v2
  可能仍有 7/7 的分数。这是选择 v3 的已知代价——不引入「v3 缺槽就回落 v2」的自动降级，
  那会在同一根曲线上混两种方法。
- 契约面测试：路由映射断言快照与历史两条路由都带配置里的版本、改配置后两端一起回退、
  越界值如实透传；词典 zh/en 键与占位符对齐；视图冒烟断言副标题版本来自载荷。

- 本地使用流程：`pnpm --filter @dshtrading/client-ui-special-indicators build`
  → profile 接线（一次性）→ `scripts/refresh-trading-web-profile.sh`。
  包改码后须重建再刷新（file: 是安装时快照）。
- **preflight 世代检查豁免**：`profile-config-preflight.sh` 检查 4 要求
  node_modules/@dshtrading/* 全体同版本（fixed 族防局部刷新残留）；本包
  private 且版本独立演进，已加入具名豁免（DRIFT_EXEMPT）——否则每次
  版本联动后本地刷新都会假阳性 FAIL。（**2026-09-17 晚取代**：插件接入桌面
  vendor 闭包后并入 fixed 组版本流，ignore 移除、世代检查改按 private 字段
  泛化跳过，见
  [desktop-update-payload-family-version-parity](../bug-fix/2026-09-17-desktop-update-payload-family-version-parity.md)。）发布版本门禁（verify-release-version）
  对 private 包的同口径豁免见
  [release-version-gate-private-package-exempt](../bug-fix/2026-09-17-release-version-gate-private-package-exempt.md)。
- 测试 34 例（jsdom 冒烟 10 例：二级页签切换/持久化/按需加载请求面/
  回访零网络+刷新只重拉已加载页签/未配置引导/状态桥故障/面板隔离/
  懒加载入口接管），覆盖率棘轮因视图冒烟回到基线之上（纯 host 测试
  时曾掉 0.27pp）；jsdom 的 localStorage 是空壳，持久化断言用
  defineProperty 内存 Storage 契约假件（repo 既有同口径实证）。
- typecheck 棘轮新增三个 tsconfig 基线（client=3 / host=0 / root=0）：
  3 条 = 全仓 client 包同款系统性债（LocaleNamespaceMap augmentation 在
  tsc bundler 解析下 TS2664，连带 ctx.locale TS2339×2；knowledge/strategies/
  settings 均带同款），包自身类型面零债。
- 单测构成：finance-client 8 / route-handler 9 / wire 5 / locale-contract 2 /
  view.smoke 9 / lazy-entry.smoke 1，BDD 合规零新债。
- 懒加载用例的等待窗口（2026-10-27）：`fallback=null` 让动态 import 落地前渲染为空，
  `findByText` 默认 1s 在满载 runner 上不够（2026-10-24 nightly 的 ubuntu 探测红成
  「找不到『特殊指标未配置』」而 body 只有空 div）。该例等待放宽到 5s，断言不变——
  被等的是视图本体 + lightweight-charts 的 transform 落地，不是行为。
- **桌面壳接线**（2026-09-17 同日补齐）：desktop/scripts/build-runtime.mjs
  新增 PRIVATE_VENDOR_PACKAGES 白名单——private: true 挡的是 npm 发布，
  不挡安装器分发，本包与其他工作区包同款 pnpm pack 进
  runtime/profile-trading/vendor/ 并列入 DIRECT_TRADING_PACKAGES；
  桌面种子 cordis.patch.yml 加 insert 行（**不落密码**，凭据走凭据链，
  未配置显示引导占位）。已验证 desktop/tests 21 例与完整
  build-runtime.mjs（pack → manifest → install → 暂存断言）。
  本机桌面端与 CLI 共用 ~/.dsh-trading/profiles/trading-web（无
  .dsh-desktop-seed.json 标记 = 用户管理，桌面永不 reseed 覆盖），
  refresh 脚本刷新的包副本对桌面端即时生效，宿主重启即加载。
- **图表呈现（2026-09-18 追加）**：序列名改由图上方 HTML 图例承载、四张图尺寸
  改由容器 flex 驱动（`LineChart` 删 `height` prop、画布 `autoSize`），
  见 [特殊指标图表图例与容器自适应](../bug-fix/2026-09-18-special-indicators-chart-legend-and-fill.md)。