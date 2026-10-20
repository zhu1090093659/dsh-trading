/**
 * 港美股开头的**身份核对**:行情源(腾讯)与公司资料源(东财 F10)各自报的公司名要对得上。
 * 对不上、或任一边没有名称 → profile 必须写 operation=identity_check 的缺口:读者得知道
 * "这份研究对的是不是那家公司"没核实(代码写错一位、ADR 与本地股混了,数字照样能算出来)。
 * 🔴 只比名称:东财那边的证券代码是按请求代码拼出来的,不是独立来源,比它等于自证。
 */
import type { RunView } from "../validator.ts";

/** 中文简称:去空白与标点,去港股同股不同权 / 二次上市后缀(-W / -SW / -S / -B / -R) */
const zh = (s: string) => s.replace(/[-－](?:SW|W|S|B|R)$/i, "").replace(/[\s\p{P}\p{S}]/gu, "");
/** 英文名首个实词:去掉公司形式词,ADR 写法差异(Inc. / Ltd / Holdings)不影响 */
const EN_STOP = new Set(["the", "inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "holding", "holdings", "group", "class", "new", "sa", "nv", "ag", "adr", "ads"]);
const enHead = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !EN_STOP.has(w))[0] ?? "";

const names = (run: RunView, id: string, fields: string[]) =>
  (run.fetch[id]?.evidence ?? []).filter((e) => fields.includes(e.field) && typeof e.value === "string" && e.value.trim()).map((e) => String(e.value));

export function identityCheck(run: RunView): { ok: boolean; reason: string } {
  const qZh = names(run, "global_quote_ref", ["security_name"]).map(zh).filter((s) => s.length >= 2);
  const pZh = names(run, "em_global_profile", ["company_short_name", "company_name"]).map(zh).filter((s) => s.length >= 2);
  const qEn = names(run, "global_quote_ref", ["security_name_en"]).map(enHead).filter((s) => s.length >= 3);
  const pEn = names(run, "em_global_profile", ["company_name_en"]).map(enHead).filter((s) => s.length >= 3);
  if (!(qZh.length || qEn.length)) return { ok: false, reason: "行情源(global_quote_ref)没有公司名称" };
  if (!(pZh.length || pEn.length)) return { ok: false, reason: "公司资料源(em_global_profile)没有公司名称" };
  if (qZh.some((a) => pZh.some((b) => a === b || a.includes(b) || b.includes(a)))) return { ok: true, reason: "中文名称一致" };
  if (qEn.some((a) => pEn.includes(a))) return { ok: true, reason: "英文名称一致" };
  return { ok: false, reason: `两个来源的公司名对不上:行情源 ${names(run, "global_quote_ref", ["security_name", "security_name_en"]).join(" / ")},资料源 ${names(run, "em_global_profile", ["company_short_name", "company_name_en"]).join(" / ")}` };
}
