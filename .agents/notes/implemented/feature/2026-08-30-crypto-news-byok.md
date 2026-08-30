# Agent Note: CryptoPanic 自备 key（WS2c）——B 源增强 + 降级为常态路径

Status: implemented

## Problem

WS2c（docs/analysis-roadmap.md #4）要给新闻工具加用户自备 key：settings `dshtrading.news.cryptoPanicKey`（可选字段），
有 key 时 `crypto_get_news` 走 CryptoPanic 免费层（B 增强），无 key 优雅降级到 WS2b 公共源并在输出注明。
前置 #3 的 `crypto_get_news`（见 [[2026-08-30-crypto-get-news]]）。而 spike（PR #7）实测 CryptoPanic 在本出口
**不可用**（免费路径 404 退役、legacy 403、api 网关子域 TLS 重置），因此必须回答：B 源如何在不依赖本出口可达
的前提下落地，并保证降级是常态路径而非异常。

## Decision

- **settings 字段注册在既有 `dshtrading` 命名空间**：扩展 `@dsh-trading/router`（该命名空间的 owner）的 Config
  schema，加 `news: { cryptoPanicKey?: string }`（`installSettingsSection` 复用，用户层赢、base 默认空 = 无 key）。
  在 `MarketRouterService` 上加 `newsKey()` 访问器（settings resolved 值）。不加独立 `news` settings plugin——
  这个命名空间就是 dshtrading 的一级配置，新闻 key 与市场 provider 同属用户设置，一份 schema 一处 owner。
- **kit 工具经 host 面 router 服务读 key**：kit-crypto `apply` 用 `ctx.get('tradingMarketRouter').newsKey()`（scope
  链向上解析，与连接器读路由同规则；router 缺席 → 无 key → 公共源）。applies:'restart' 语义——apply 时读一次，
  新建会话生效（与 provider 路由口径一致）。
- **CryptoPanic 为 B 增强，fed 进 `crypto_get_news` 的源列表**：有 key → 加 `fetchCryptoPanicNews`（`{results:[...]}`，
  `published_at`/`url`/`title`）；失败 → 落入 `Promise.allSettled` rejected 分支 → `unavailable` 注明（fail-soft），
  A 级公共源照常返回。**降级（含本出口必现的 CryptoPanic 失败）就是常态路径，不是异常路径**——这与 spike 结论一致。
- **settings UI 行**：`dshtrading.market.tab` crypto 面板加 CryptoPanic API Key 输入（password 输入 + 保存/放弃 +
  revision-fenced `scope.mutate`，`['news','cryptoPanicKey']` path；空串 = unset 回公共源）。复用既有 section 机制，
  locale zh/en 双语。

## Alternatives considered

- **独立 `@dsh-trading/news-settings` 插件注册 news 命名空间**：落选——dshtrading 是市场/交易用户设置的一级
  namespace，一个 key 字段不值得另起一个 owner；多 owner 会破坏「命名空间一份 schema 一处 owner」的既有契约。
- **有 key 时用 CryptoPanic 完全替换公共源**：落选——roadmap Q3 定稿「A 打底 + B 增强」，B 是增强不是替换；
  且本出口 CryptoPanic 不可达，替换会让该出口下的无 key 用户功能受损。
- **本轮不做 settings UI（只留 schema）**：落选——issue #4 验收含「settings UI 展示该字段」；既有的 crypto 面板
  加一行是低风险增量（复用 controller + panel save/discard + revision 模式）。
- **CryptoPanic 活路径本出口验证**：未实现——本出口 TLS 重置无法端到端确认（api 子域握手即断）。活路径按文档
  形实现 + mock 全测；降级（本出口必现）已 live 实测（假 key → cryptopanic 404 → 公共源照常返回）。留待外部出口
  /真 key 复验后确认。

## Consequences

- `dshtrading.news.cryptoPanicKey` 可经 `~/.dsh/settings.yaml` 或 settings UI 设置；无 key（默认）时 `crypto_get_news`
  行为与 WS2b 完全一致（公共源，无 B 源）。
- CryptoPanic 主路径编码 + mock 两态单测（有 key → B 源被聚合、失败 → unavailable 注明 + 公共源照常）；降级 live
  实测通过。活跃活路径（CryptoPanic 真实响应）未在本出口验证——需外部可访问出口/真实 key 补验（写入
  `spikes/impl-crypto-news/EVIDENCE.md` §CryptoPanic 的结论，关联 WS2c）。
- 全量 `pnpm -r build`/`-r test` 门禁由 PR CI 承接；本地已对 router（14 例）、kit-crypto（16 例）、client-ui-settings
  （5 例 + 双 tsdown 构建）验证。
