/**
 * **金融行业词表**(Plugin 的一个插槽)。
 *
 * 架构审计 2026-08-24:数字忠实度的**机制**是通用的(剥非主张数字 → 绑定证据),
 * 但它依赖的**词表是行业的** —— `SPEED_CTX_RE` 里甚至写着"光模块 / CPO / OSFP",
 * 那是光通信行业的产品类别名。餐饮 AgentOS 的对应词表会完全不同(客单价 / 翻台率 / 门店数…)。
 * ⇒ 词表落进 `src/finance/`,Core 只接受一个 `Lexicon` 参数。
 *
 * ⚠️ 下面每条正则里的每个词都对应一次真实误伤(见 number_fidelity.ts 的注释与各轮 Codex 审计)。
 * **原样搬过来,一个字符都没改。** 改它们之前先读注释。
 */
import type { Lexicon } from "../number_fidelity.ts";

const MONEY_BEFORE_RE = /(市值|营收|收入|金额|利润|资产|负债|现金|估值|USD|RMB|CNY|HKD|EUR|[$¥€£￥])(?:约|为|达|超过|接近|近|逾|的|总计|合计|规模|\s)*$/i;
const MONEY_AFTER_RE = /^\s?(USD|RMB|CNY|HKD|EUR|美元|美金|港元|人民币|元(?!器件)|亿|万|%|倍)/i;
const SPEED_CTX_RE = /(光模块|模块|速率|链路|端口|以太|放量|出货|交换机|硅光|CPO|LPO|OSFP|QSFP|收发|传输|网络|产品|需求|订单|方案|器件|讨论|提及|话题|热议|升级|代际|bps|\d\s?[TG]b?(?![A-Za-z])|光|铜|\/)/i;

/** 证券语境:6 位数字代码,前后可带 代码 / 证券 / 标的 / 股票 / 简称 / SH·SZ·BJ */
const SUBJECT_CODE_CONTEXT = /(?<=[(（【]|代码|证券|标的|股票|简称|[Ss][HhZz]|[Bb][Jj])\s*(?<![\d.])\d{6}(?![\d.])/g;
const SUBJECT_CODE_SUFFIX = /(?<![\d.])\d{6}(?![\d.])(?=\s*[)）】]|\.(?:SH|SZ|BJ|sh|sz|bj))/g;
/** 港股语境:HK:00700 / 港股 0700(4-5 位);括号里 0 开头的 5 位(00700)。00700.HK 已被域名规则剥掉。
 *  🔴 后面紧跟金额 / 数量单位的不是代码:「净买入港股 8000 亿港元」「港股 12345 手」「(01234 万元)」都是主张(阶段 D 审查 P1) */
const HK_NOT_AMOUNT = "(?!\\s*(?:[%％‰倍元亿万千百手股只家个份张台辆吨笔次户人]|港元|美元|HKD|USD|CNY|RMB|bn|mn|[KMB](?![A-Za-z])))";
const HK_CODE_CONTEXT = new RegExp(`(?<=(?:HK|hk|港股)\\s*[:：]?\\s*)(?<![\\d.])\\d{4,5}(?![\\d.])${HK_NOT_AMOUNT}`, "g");
/** 括号里只有代码:紧接右括号 / 分隔符才算 */
const HK_CODE_BRACKET = /(?<=[(（【]\s*)0\d{4}(?=\s*(?:[)）】,，、/]|$))/g;
/** 时间窗口标签:"约 30 日涨跌" / "7 日均价" —— 窗口里的数字不是主张 */
const WINDOW_LABEL = /约?\s?\d+\s?[日天](?=\s*(涨跌|变动|均价|均值|窗口|区间|回撤|新高|新低|走势|涨幅|跌幅))/g;

/**
 * 对话数字闸门(number_gate.ts)用的「名称 / 窗口」写法,只作用于对话,不改报告的核对:
 * - 指数名里的数字(沪深300 / 中证500 / S&P 500);后面跟 点 / % / 单位的是点位或数值,照样核对;
 * - 均线与交易日窗口(60 日均线、250 日线、60/120/250 日均线、近 30 个交易日)。
 */
const INDEX_NAME = /(?<=沪深|中证|上证|深证|科创|创业板|北证|国证|恒生|标普|纳斯达克|纳指|罗素|S&P|Nasdaq|NASDAQ|Russell|CSI)\s?(?:50|100|180|300|500|800|1000|2000)(?![\d.])(?!\s*(?:点|%|倍|元|亿|万))/g;
const MA_WINDOW = /(?<![\d.])\d+(?:\s*[/、,，]\s*\d+)*\s*(?:个\s*)?(?:交易日|[日周月]\s*均线|[日周月]线)/g;
export const FINANCE_GATE_LABELS: readonly RegExp[] = [INDEX_NAME, MA_WINDOW];
/**
 * 一致预期分歧的固定阈值:valuation / catalyst-risk 两个 skill 写死「max ÷ min ≥ 2 倍」算分歧大。
 * 报告的裁决点会写「max/min 升至 2 倍以上」—— 这个 2 是本产品的规则,不是数据,没有证据可引。
 * 只认同一句里前面出现「分歧」或「max ÷ min」的整数 2 倍;1.23 倍、2.5 倍这类数值照样核对。
 */
const DISPERSION_RULE = /(?<=(?:分歧|max\s*[÷/]\s*min)[^。；;\n]{0,60}?)(?<![\d.])2\s*倍(?![\d.])/gi;

export const FINANCE_LEXICON: Lexicon = {
  moneyBefore: MONEY_BEFORE_RE,
  moneyAfter: MONEY_AFTER_RE,
  categoryLabelContext: SPEED_CTX_RE,
  subjectCodePatterns: [SUBJECT_CODE_CONTEXT, SUBJECT_CODE_SUFFIX, HK_CODE_CONTEXT, HK_CODE_BRACKET],
  windowLabelPattern: WINDOW_LABEL,
  subjectCodeIsSixDigits: true,
  labelPatterns: [DISPERSION_RULE],
};

/**
 * 📌 这些词表对应过的真实误伤(搬自 number_fidelity.ts,与词表放在一起才有意义):
 * - 速率标签:`1.6T / 800G / 400Gbps` 是光模块的产品类别名,不是数字主张;但 `总市值约 1.6T`、
 *   `1.6T 美元` 里的 T 是金额 —— 所以要"有类别语境、无金额语境"才剥(Codex voice-r1 / r2)。
 * - 主体编号:A 股 6 位代码;港股 4-5 位代码只在 HK / 港股 前缀或括号里 0 开头时剥(v2.1 接通港股研究:报告身份句写「HK:00700」)。⚠️ ht21 真踩 —— 沪铜 `107520 元/吨` 恰好也是 6 位,
 *   旧规则一律当代码剥掉,让它**从不参与绑定校验**,是个既有假绿;所以只在**代码语境**
 *   (括号内 / 代码·证券·标的·股票 前缀 / SH·SZ·BJ 前后缀)或等于本次标的代码时才剥。
 * - 时间窗口标签:`约 30 日涨跌` / `7 日均价` / `30 日回撤` 里的数字是窗口长度不是数据点。
 *   ⚠️ ht21 真踩:大宗那行 5 个涨跌值都绑好了,却被窗口里的 30 判成未绑定。
 *   但 `回款周期约 30 天` 是真主张,所以必须**后接窗口词**才算标签(Codex commodity-r2)。
 */
