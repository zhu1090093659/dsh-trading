# Agent Note: 股票按名称筛选与大盘指数（科创50等）支持

Status: implemented

## Problem

在行情与自选面板中存在两个核心阻碍用户选股与查阅指数的缺陷：
1. **无法按中文名称筛选与提交**：
   - 侧栏添加标的输入框在表单提交（`onSubmit`）时，仅按代码（`symbol`）进行比较，忽略了名称（`name`）。用户直接输入中文（如“科创50”或“贵州茅台”）并按回车时，前端代码将纯中文字符串作为 symbol 提交并请求行情，导致后端抛出 `TRADING_UNSUPPORTED_SYMBOL: Symbol "科创50" is not a valid CN A-share symbol`。
   - 默认激活的 A 股数据源连接器 `@dshtrading/connector-tencent` 未实现 `listInstruments(query?: string)`，导致 Bridge `/dshtrading/api/symbols?query=...` 恒返回空列表，在线联想能力失效。
2. **未支持大盘指数（科创50等）**：
   - 静态词典 `SYMBOL_CATALOG.cn` 缺少科创50（`000688.SH`）、上证指数（`000001.SH`）、沪深300（`000300.SH`）等核心大盘与宽基指数。
   - 代码规范化逻辑 `normalizeCnSymbol` 将所有 `0` 开头的 6 位代码一律归为深圳（`sz`），导致裸码 `000688` 误转为 `sz000688`，而非上交所指数 `sh000688`。

## Decision

1. **连接器层支持智能联想与指数代码规范化**：
   - 在 `@dshtrading/connector-tencent` 的 `TencentRestClient` 中实现 `listInstruments(query?: string)`，对接腾讯智能联想接口 `https://smartbox.gtimg.cn/s3/?t=all&q=...`，支持按中文名、拼音缩写（如 kc50）、代码实时模糊检索，返回统一规范化的指数（ZS）、股票（GP）与 ETF 标的列表。并在 `TencentMarketDataService` 中导出并代理该方法。
   - 优化 `normalizeCnSymbol`：维护知名上海核心指数代码集（`000688` 科创50、`000300` 沪深300、`000016` 上证50、`000905` 中证500、`000852` 中证1000）以及 `5` 开头的沪市基金/ETF，在裸码输入时正确识别映射为 `sh` 前缀。
   - 修正 `@dshtrading/connector-eastmoney` 的 `toEastmoneySecid`，同步支持上述知名指数映射为上海 `1.xxxxxx` secid。
2. **静态词典扩充核心大盘指数**：
   - 在 `packages/router/src/catalog.ts` 的 `SYMBOL_CATALOG.cn` 静态种子中增补科创50、上证指数、深证成指、创业板指、沪深300、上证50、中证500、中证1000、科创50ETF、沪深300ETF；在 `SYMBOL_CATALOG.hk` 增补恒生指数、恒生科技、国企指数。
   - 升级 `searchSymbols` 与 `searchAllMarkets` 打分算法，精确匹配中文名称（`name === q`）给予最高优先级（score 0），前缀包含（`name.startsWith(q)`）给予高优先级（score 1）。
3. **前端 UI 交互与防呆增强**：
   - 优化 `MarketSidebar.tsx` 的联想防抖触发门槛至 1 个字符（支持输入“科”即可触发联想）。
   - 重构 `onSubmit`：优先匹配名称与代码的完全匹配与前缀匹配；用户在输入中文并按回车时自动取首个有效匹配项的规范代码；若输入包含中文且完全无法匹配任何标的，予以安全拦截，杜绝将非法纯中文当作代码提交到后端。

## Alternatives considered

1. **由前端直接构造中文与代码的映射写死在组件内**：
   - 否决原因：违背架构原则。标的发现与代码词汇应集中在 host 侧数据源连接器（`listInstruments`）与 SSOT 词典（`@dshtrading/router/catalog`）中，保持各市场插件独立性和可扩展性。
2. **在用户输入中文回车后盲目按拼音生成虚拟代码**：
   - 否决原因：极易推造出不存在的虚假代码并污染用户自选与行情缓存，必须严格基于连接器上游返回的真实代码或静态种子进行映射。

## Consequences

- 股票与指数搜索体验对齐同花顺等主流交易软件，支持中文名、拼音缩写、代码全方位实时检索与回车选中。
- 完美支持“科创50”、“上证指数”、“沪深300”等大盘指数的搜索、自选添加、实时行情与 K 线渲染，不再报 `TRADING_UNSUPPORTED_SYMBOL`。
- 全量单元测试（1086 tests）与构建 100% 保持通过。
