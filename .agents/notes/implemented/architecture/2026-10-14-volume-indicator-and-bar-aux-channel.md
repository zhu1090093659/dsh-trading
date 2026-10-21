# Agent Note: 成交量进指标系统：`vol` 预置指标 + 逐根序列（barAux）注入通道

Status: implemented

## Problem

成交量柱此前是图表层的内置特例：`TvChart` 固定用 pane 1 画它，颜色由红涨绿跌设置与五日档位两套逻辑各自改写。三处缺口：

1. **它不在指标系统里**：不在名册、没有 definition、图例与读数体系里没有它。用户要的「取消勾选后整个成交量副图消失」根本无法表达——pane 由图表层永久持有，与名册无关。
2. **颜色语义错位**：成交量柱按涨跌语义取色（收盘 ≥ 开盘记上涨），却被「红涨绿跌」设置整体翻转；用户换配色偏好不该把成交量的涨跌语义翻过来。
3. **档位色缺少注入缝**：五日级别的量比档位色只能由图表层逐根替换柱色（`resolveVolumes` + `fiveDayVolumeColor`），指标契约里没有任何「逐根外部数据」通道——已有的 `aux` 是**日频外部序列**（按交易日公布，取不到即整体隐藏实例），与「按 K 线级别逐根算出的增强序列」不是一回事。

## Decision

**成交量成为一条普通的可取消预置指标 `vol`（`packages/indicators/src/presets.ts`），档位色经新增的逐根序列通道 `barAux` 注入它。**

**预置 `vol`（`pane: 'sub'`，无参数，`defaultActive: true`，不限市场与级别）**：

- `compute(bars, params)` 出两条 histogram：`上涨量` / `下跌量`。方向判据 = **收盘 ≥ 开盘记上涨（等号归上涨）**，二分覆盖完整；柱高 = 本周期成交量；`volume` 非有限（脏数据）不出柱。两条 `values.length` 严格等于 `bars.length`，绝不出现 `NaN`/`Infinity`。
- 颜色写死为红涨绿跌**缺省档**的语义色：上涨 `rgba(230, 69, 69, 0.55)`、下跌 `rgba(43, 164, 113, 0.55)`（镜像 `packages/client-ui-trading/src/client/color-mode.ts` 的 `PALETTES['red-up'].upAlpha(0.55)` / `downAlpha(0.55)`，本包不能反向依赖 UI 包）。柱色**不读**红涨绿跌设置。
- 纵轴格式：`vol` 的七条输出（`compute` 两条 + `computeBarAux` 五条）都声明 `priceFormat: 'volume'`——柱高是成交量，纵轴要走成交量的紧凑格式（亿/万、K/M/B），否则通用价格格式会把它渲染成 `12000000.00`。`IndicatorOutput.priceFormat?: 'price' | 'volume'` 缺省 `'price'`（消费方兜底），其它预置不带该字段，存量零迁移。
- `defaultActive: true` 让宿主启动时补种一次（见 [volume-tier-indicator-generalization](2026-10-14-volume-tier-indicator-generalization.md) 的补种机制）；`vol` 的 definition 排在 `vol-tier` **之前**，因此新工作区的补种顺序是 `['vol', 'vol-tier']`，成交量副图落在量比分档量能上方。

**逐根序列通道（`packages/indicators/src/aux-series.ts` + `types.ts`，冻结词汇）**：

- `AuxBarSeriesKey`（开放词汇）/ `AuxBarSeriesMap`（键 = `definition.barAux` 声明的键，值数组长度严格等于 `bars.length`，`undefined` = 该根无值，元素只可能是有限数或 `undefined`）。
- `IndicatorDefinition.barAux?: readonly AuxBarSeriesKey[]` + `computeBarAux?(bars, params, barAux)`，均为可选，存量 definition 零迁移。
- **两条通道的语义分界**：`aux` = 日频外部序列，取不到即整体隐藏实例（空 ≠ 0）；`barAux` = **级别相关的增强通道**，缺失时**回落 `compute`**，绝不隐藏实例。
- 五日成交量档位通道键 `FIVE_DAY_VOLUME_TIER_AUX_KEY = 'five-day-volume-tiers'`；档位编码词汇 `FIVE_DAY_VOLUME_TIER_CODES = ['noPrior', 'lt1', 'lt2', 'lt3', 'gte3']`，**下标即编码值**，类型 `FiveDayVolumeTierCode = 0 | 1 | 2 | 3 | 4`。编码 0 = 不可判（无前值 / 基准日 / 前值无量），1..4 = 量比四档。

**`vol.computeBarAux(bars, params, barAux)`**：出五条 histogram，key 与顺序与 `vol-tier` **完全一致**（`无前值 / 量比<1 / 量比1-2 / 量比2-3 / 量比≥3`，即 `VOLUME_TIERS` 的下标顺序），颜色复用同一张 `VOLUME_TIER_THEME_COLORS`（不建第二份档位色表）；柱高 = 本周期成交量，每根至多落在一条输出上；编码越界（含小数、负数、超范围）或 `undefined`、以及 `volume` 非有限时该根不出柱。

**客户端消费（跨包事实，`packages/client-ui-trading`）**：`TvChart` 不再有内置成交量 pane——pane 1 = 激活顺序里的第一个副图指标（含 `vol`），取消勾选即整个副图消失；五日级别的档位序列由客户端算出后经 `barAux` 注入，`vol` 用档位色出柱。档位色值的唯一事实来源仍是 `five-day-series.ts` 的 `TIER_COLORS_LIGHT` / `TIER_COLORS_DARK`（图例色块继续读它），`presets.ts` 的表是逐档同值镜像。

**工具面连带事实**：预置从 9 条增至 10 条，`<market>_get_indicators` 的默认集随之变化（crypto/us 7 → 8 个 id、hk 8 → 9 个 id；crypto/hk 的 `tail=` 行数 27 → 29）。`packages/indicators/test/tool.test.ts` 的三处计数夹具、`packages/indicators/test/chart-seed.test.ts` 的默认勾选 id 集合夹具（`['vol-tier']` → `['vol', 'vol-tier']`）同批更新，断言语义不放松；`chart-seed.test.ts` 另补一条「一次补种命中两条默认勾选定义」的用例。

## Alternatives considered

- **把逐根档位序列塞进已有的日频 `aux`**：零新契约。否决——`aux` 的语义是「取不到就整体隐藏实例」，而档位序列缺失时成交量柱必须照常以涨跌色出柱；把增强通道伪装成数据源，会让「这一级别算不出档位」退化成「成交量副图整块消失」。单位也对不上：`aux` 按交易日对齐，档位按逐根对齐。
- **图表层继续硬编码 pane 1 施色**：改动最小，不碰指标契约。否决——与「成交量进指标系统、可取消」直接冲突：实例被取消后 pane 是否还存在只能由图表层再判一次；档位色与涨跌色的优先级也继续留在宿主图表层，指标契约无法表达。
- **给 `IndicatorOutput` 加逐根色数组（`colors?: string[]`）**：一条序列就能表达多档颜色。否决——该方案在 `vol-tier` 泛化时已被否决（五条序列 + `themeColor` 用契约已有机制即可，见 [volume-tier-indicator-generalization](2026-10-14-volume-tier-indicator-generalization.md)）；`barAux` 动的是**输入侧**，不引入第二条输出侧颜色通道。
- **档位编码用档位名字符串数组而不是数字编码**：可读性更好。否决——逐根数组每根都携带一个字符串（序列化与内存开销），且要在契约里再开一套字符串词汇；数字编码 + 冻结编码表把「下标即编码值」写死，越界即不可判、无需字符串比较。

## Consequences

- 用户可见：成交量副图默认出现（补种一次），取消勾选即整块消失；柱色是固定的涨跌语义色，换红涨绿跌设置不会翻转它；五日级别的柱色改由档位色承载，档位语义（四档阈值、基准日与不可判归中性灰、前值无量而本周期有量落最高档）与「行情·5日」逐条一致。
- `barAux` 与 `aux` 的缺失语义相反，是本契约最容易用错的一处：`aux` 缺失必须隐藏、`barAux` 缺失必须回落 `compute`。两条都在 `definition` 上以可选字段声明，存量指标零迁移。
- 编码表与档位顺序是一对事实：`FIVE_DAY_VOLUME_TIER_CODES` 的下标即 `VOLUME_TIERS` 的下标。加一档必须两处同改，`packages/indicators/test/volume.test.ts` 断言五条输出 key 的顺序、`aux.test.ts` 断言编码表下标与编码类型取值域同长，只改一处会被拦住。
- 档位色仍是**镜像而非共享**：`presets.ts` 与 `five-day-series.ts` 两处字面量必须同步改，单测冻结字面量以逼出「只改了一处」。彻底收口需要把色表下沉到 indicators 包（本次未做）。
- 补种事实变化：存量工作区升级后第一次启动会补种两条（`vol` 与 `vol-tier`），账本记两条；用户删掉其中一条后该条不复活，另一条不受影响。
- 证据边界：本包定向测试 160 例全绿、`tsc --noEmit` 10 错（= `scripts/typecheck-baseline.json` 基线，全为存量）、`test:audit --check` 无新增测试债；客户端接线与真机 UI 验证属 `client-ui-trading` 侧范围，不在本包证据内。
