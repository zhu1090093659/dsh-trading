/**
 * 资料库里的**证券代码规则**:从资料的文件名、正文认出主体代码,把问题里的代码写法换成入库形式。
 * 经 `Plugin.reportRecall.symbols` 交给 Core 的资料库(`report_library.ts`),Core 只按返回的字符串比对。
 *
 * 🔴 原来写在 Core 里,第二个垂类用资料库时这些 A 股 / 港股 / 美股规则也会照跑(Codex 审计第三轮 A6)。
 *    规则本身原样搬过来,没有改判定。
 */

/** 资料的文件名 + 正文 → 主体代码(港股规范成 5 位、美股大写),最多 20 个 */
export function reportSymbols(name: string, text: string): string[] {
  const found = new Set<string>();
  const body = text.slice(0, 120_000);
  // 北交所老号段 43x / 新号段 92x 以 4、9 开头,不收进来会让「430047 怎么看」完全召不回(Codex r23 P1)
  const sixDigitId = "((?:0|3|4|6|8|9)\\d{5})";
  // 文件名是用户主动给出的元数据，可直接识别合法形状的六位主体标识；正文里的任意六位数
  // 可能是装机量、合同额或样本编号，只有带明确“代码 / 交易所”语境时才认。
  for (const m of name.matchAll(new RegExp(`(?<!\\d)${sixDigitId}(?!\\d)`, "g"))) found.add(m[1]!);
  const bodyPatterns = [
    new RegExp(`(?:公司)?代码\\s*[:：#-]?\\s*${sixDigitId}(?!\\d)`, "gi"),
    new RegExp(`(?:SH|SZ|BJ)\\s*[:：#.-]?\\s*${sixDigitId}(?!\\d)`, "gi"),
    new RegExp(`(?<!\\d)${sixDigitId}\\s*\\.(?:SH|SZ|BJ)\\b`, "gi"),
    new RegExp(`[\\u3400-\\u9fffA-Za-z]{2,30}[（(]\\s*${sixDigitId}\\s*[）)]`, "g"),
  ];
  for (const re of bodyPatterns) for (const m of body.matchAll(re)) found.add(m[1]!);
  const sample = `${name}\n${body}`;
  for (const m of sample.matchAll(/\b([0-9]{1,5})\.HK\b/gi)) found.add(m[1]!.padStart(5, "0"));
  for (const m of sample.matchAll(/(?:港股|HK)\s*[:：#-]?\s*([0-9]{1,5})(?!\d)/gi)) found.add(m[1]!.padStart(5, "0"));
  for (const m of sample.matchAll(/(?:NASDAQ|NYSE|AMEX|TICKER|SYMBOL|代码)\s*[:：#-]?\s*([A-Z]{1,5})\b/g)) found.add(m[1]!);
  for (const m of sample.matchAll(/\$([A-Z]{1,5})\b|\b([A-Z]{1,5})\.US\b/g)) found.add((m[1] || m[2])!);
  return [...found].slice(0, 20);
}

/**
 * 问题里的港股写法 → 入库时的五位码。资料导入把 `HK:700` / `700.HK` 规范成 `00700`,
 * 这里若只按字面量比,用户用系统别处都接受的写法就命不中(Codex r4 P2)。规则与 reportSymbols 同源。
 * normMessage 是 Core 规范过的问题文本(小写)。
 */
export function reportSymbolAliases(normMessage: string): string[] {
  const out = new Set<string>();
  for (const m of normMessage.matchAll(/(?<![a-z0-9])(\d{1,5})\.hk(?![a-z0-9])/g)) out.add(m[1]!.padStart(5, "0"));
  for (const m of normMessage.matchAll(/(?<![a-z])(?:港股|hk)\s*[:：#-]?\s*(\d{1,5})(?!\d)/g)) out.add(m[1]!.padStart(5, "0"));
  return [...out];
}

/**
 * 问题里的裸六位代码。只认合法号段(0 / 3 / 4 / 6 / 8 / 9 开头,与 reportSymbols 同一口径):
 * 日期 / 金额这类六位数(202409)不是代码(Codex r25 P1)。
 */
export function reportBareCodes(normMessage: string): string[] {
  return [...new Set([...normMessage.matchAll(/(?<!\d)([034689]\d{5})(?!\d)/g)].map((m) => m[0]))];
}
