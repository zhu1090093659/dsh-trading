/**
 * 指标系统契约类型（纯数据）：definition 是指标系统的唯一扩展点——
 * pane 归属 + 显示字符串 + 参数 schema + 纯函数 compute。渲染层（宿主
 * 行情视图）只消费 compute 的输出，对指标实现零感知。
 *
 * 显示字段（title/label）是普通字符串而非 locale 键：宿主 locale 命名空间
 * 单占（重复 register 抛错），外部指标插件不可能往宿主拥有的命名空间贡献
 * 键；社区指标因此只需交付纯数据 definition，无需 i18n 通道。内置指标名
 * （MA/MACD 等）本身语言中立。
 *
 * 外部序列注入缝（2026-10-13 港股通持股比例）：指标可用 aux 声明需要宿主预取的
 * 外部日频序列键，宿主按需 prefetch 后走 computeAux 入口（见 aux-series.ts）。未声明
 * aux 的存量 definition 完全不受影响。
 *
 * 逐根序列注入缝（2026-10-14 五日同分钟档位色）：指标可用 barAux 声明需要宿主
 * 逐根注入的序列键，宿主把整条序列算好后走 computeBarAux 入口（见 aux-series.ts）。与
 * aux 的差别是**缺失语义**：aux 取不到就整体隐藏实例，barAux 缺失则回落 compute，
 * 实例照常显示。未声明 barAux 的存量 definition 完全不受影响。
 */
import type { AuxBarSeriesKey, AuxBarSeriesMap, AuxSeriesKey, AuxSeriesMap } from './aux-series.ts'
import type { Series } from './math.ts'

/** K 线（与宿主行情数据结构对齐的最小面）。 */
export interface Kline {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime?: number
}

/** 指标归属：主图叠加（与蜡烛共享价格轴）或独立副图 pane。 */
export type IndicatorPane = 'main' | 'sub'

export interface IndicatorParamSpec {
  key: string
  /** 参数显示名（纯字符串，见模块头注）。 */
  label: string
  default: number
  min: number
  max: number
}

/** 主题双色（亮/暗各一色）：同一语义在两种主题底上各自可辨的取色。 */
export interface IndicatorThemeColor {
  light: string
  dark: string
}

export interface IndicatorOutput {
  /** 实例内唯一（图例/序列 key）。 */
  key: string
  kind: 'line' | 'histogram' | 'area'
  color: string
  /**
   * 主题双色（可选）：消费方按当前宿主主题取 light / dark；缺席回落 {@link color}
   * （存量指标与自定义指标零迁移）。{@link color} 仍是必需字段——旧消费方读到的是
   * 同一语义的亮色值，不会出现「无色可用」。
   */
  themeColor?: IndicatorThemeColor
  /** 与 K 线逐条对齐；undefined = warm-up，不画。 */
  values: Series
  /** 纵轴/十字线数值格式：'volume' = 成交量紧凑格式（亿/万、K/M/B），缺省 'price'。 */
  priceFormat?: 'price' | 'volume'
  /** histogram 专用：按符号红涨绿跌着色（MACD 柱）。 */
  histogramBySign?: boolean
  /** area 专用：顶部渐变色 */
  topColor?: string
  /** area 专用：底部渐变色 */
  bottomColor?: string
  /** area 专用：反转填充区（true 表示向线上方填充） */
  invertFilledArea?: boolean
  /** 线宽（1-4） */
  lineWidth?: number
  /** 图例/读数小数位（缺省 2）：成本线类自定义指标可设 3 提高读数分辨率。 */
  precision?: number
}

export interface IndicatorDefinition {
  /** 注册唯一 id（如 'ma'）；实例按 id + 参数区分。 */
  id: string
  pane: IndicatorPane
  /** 指标显示名（纯字符串，见模块头注）。 */
  title: string
  /**
   * 指标说明（可选）：数据来源与口径限制。预置与自定义同面，由 indicator_list
   * 与 resolveIndicatorSpec 透传给消费方（模型读指标清单时看到的就是这条）。
   */
  description?: string
  params: readonly IndicatorParamSpec[]
  compute(bars: readonly Kline[], params: Readonly<Record<string, number>>): IndicatorOutput[]
  /** 需要宿主预取的外部序列键（可选）；缺失 = 本指标只吃 K 线。 */
  aux?: readonly AuxSeriesKey[]
  /**
   * 按外部序列计算（可选）：声明了 aux 的指标由宿主走这条入口，
   * 宿主未取到数据（空/失败）时**不得调用**本函数，直接隐藏该指标渲染。
   * 与 compute 二选一：声明 aux 时宿主只认 computeAux。
   */
  computeAux?(bars: readonly Kline[], params: Readonly<Record<string, number>>, aux: AuxSeriesMap): IndicatorOutput[]
  /** 需要的逐根序列键（可选）。与 aux 的差别：barAux 缺失时**回落 compute**，不隐藏实例。 */
  barAux?: readonly AuxBarSeriesKey[]
  /** 逐根序列计算入口（可选，与 barAux 成对）：声明的键都齐备时宿主优先走它。 */
  computeBarAux?(bars: readonly Kline[], params: Readonly<Record<string, number>>, barAux: AuxBarSeriesMap): IndicatorOutput[]
  /**
   * 可用市场 slug 白名单（可选；如 ['hk']，slug 词汇同 IndicatorApplyScope）。
   * 缺席 = 所有市场可用（存量 definition 零迁移）。
   */
  markets?: readonly string[]
  /**
   * 该指标**新实例**的默认适用范围（可选；如港股通持股比例取自日频序列，分钟级
   * 没有对应数据，默认只适用 1d/1w/1M）。这是指标自身的固有属性，声明落在定义侧，
   * 三条创建路径（GUI 挂载 / indicator_activate / 桥 PUT）共用同一份事实。
   * 缺席 = 全部市场、全部级别应用（存量 definition 零迁移）。
   *
   * 只作用于新建实例：已挂载实例的 applyScope 是用户设置，任何写入路径都不得把它
   * 改回默认（用户显式改成「全部级别」之后必须保持）。
   */
  defaultApplyScope?: IndicatorApplyScope
  /**
   * 默认勾选（可选，缺省 false；只有预置定义声明）：true = 该指标要在用户的图上
   * 默认激活一次，由宿主启动时的补种完成（seedDefaultActivations，见 chart-seed.ts）。
   *
   * 补种只发生一次——用户在图上删掉后不复活，因此「补种过」单独记在
   * $DSH_HOME/indicators/chart-seed.json 账本里；这是宿主侧的初始化行为，
   * 不改变 definition 的纯数据性质，也不影响存量 definition（零迁移）。
   */
  defaultActive?: boolean
}

/**
 * 一个市场在适用范围里的配置（按市场独立启用开关 + 级别选择）。
 *
 * - `enabled: false`：该市场不应用（已选 `intervals` 原样保留，重新开启即恢复）。
 * - `enabled: true` 且 `intervals: []`：该市场不应用（「未选择级别」——空选择
 *   绝不解释为全部级别）。
 * - `enabled: true` 且有值：仅选中级别应用。
 */
export interface IndicatorMarketScope {
  /** 该市场是否启用应用（关闭只停用，不清空已选级别）。 */
  enabled: boolean
  /** 该市场适用的 K 线级别（市场级别词汇，如 "1d" / "15m"）。 */
  intervals: string[]
}

/**
 * 指标适用范围：市场 slug（"crypto" | "us" | "cn" | "hk" | "futures" | "global"）
 * → 该市场配置。
 *
 * 缺席市场 = 该市场默认全开且全部支持级别选中（新建指标与存量配置均如此，
 * 因此字段整体缺失即「全部市场全部级别应用」，零迁移）。市场键存在即按配置生效。
 */
export type IndicatorApplyScope = Record<string, IndicatorMarketScope>

/** 一个已激活的指标实例（每个 preset id 至多一个实例）。 */
export interface IndicatorInstance {
  id: string
  params: Record<string, number>
  /**
   * 按标的参数覆盖（issue #72）：key 为 `${market}:${symbol}`（如 "hk:00700.HK"），
   * 命中当前标的时该套参数整体替代全局 params。锚点类自定义指标（每标的一套
   * 锚点参数）依赖此机制；无覆盖的标的回退全局 params。
   */
  symbolParams?: Record<string, Record<string, number>>
  /**
   * 按标的隐藏表：作用域键为「market」（整市场，如 "us"）或「${market}:${symbol}」
   * （单标的，如 "hk:00700.HK"）。命中的标的不渲染该实例，其余标的跟随全局激活
   * （默认可见，存量名册零迁移）。隐藏 ≠ 取消激活：实例仍在名册，只是对该标的不可见。
   */
  hiddenScopes?: string[]
  /**
   * 适用范围（按市场独立配置适用的 K 线级别）：字段缺失 = 全部市场、全部级别应用
   * （存量名册零迁移，表现与升级前一致）。不适用 ≠ 取消激活：实例、参数与适用范围
   * 都保留，切回适用的市场/级别即自动恢复。与 hiddenScopes 正交：hiddenScopes 管
   * 标的级显隐，applyScope 管市场 + 级别级适用性。
   */
  applyScope?: IndicatorApplyScope
}
