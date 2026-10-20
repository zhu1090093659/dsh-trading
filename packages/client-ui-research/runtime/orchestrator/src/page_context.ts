/**
 * 前端「按页问答」把这一页的数据和用户的问题拼成一条消息发来，这里把两段拆开。
 *
 * ⚠️ 前端有**三种**包装:抽屉 / llm.ts 用「【问题】」分隔,常驻控制台用「（我正在看「…」这一页）」前缀(Codex r8 P1)。
 *    新增包装格式时这里要跟着认:资料召回只看问题(否则页面文字会变成意图触发器),
 *    手打上限也只管问题(否则数据多的页面一问就超长)。
 */
const PAGE_QUESTION_MARK = "\n【问题】\n";
/** 常驻控制台(AiConsole.decorate)只在问题前面加一行「我正在看某页」,页面标题本身可能含垂类词(Codex r8 P1) */
const CONSOLE_PREFIX_RE = /^（我正在看「[^」\n]*」这一页）[ \t]*\r?\n/;

/**
 * 用户手打的问题最多 4000 字。按页问答时这一页的数据拼在问题前面一起发来,整条另有上限 64000(与 chat.ts 能放宽到的上限一致):
 * 数据多的页面(每日复盘的整体数据约 6000 字)早就超过 4000,原来按整条卡,一点就报「消息须为 1–4000 字符」。
 * ⚠️ 页面数据是前端拼的,后端分不出哪段是手打的 —— 4000 只是界面上的约束,真正挡资源的是 64000。
 */
export const MAX_QUESTION = 4_000;
export const MAX_WITH_PAGE = 64_000;

/** 对话消息的长度检查:Agent、本机订阅单轮、模型直连三条路径共用;没问题返回 null */
export function chatLengthProblem(raw: string): string | null {
  if (!raw.trim()) return "消息不能为空";
  const { question } = splitPageContext(raw);
  if (!question.trim() || question.length > MAX_QUESTION) return `问题须为 1–${MAX_QUESTION} 字符`;
  if (raw.length > MAX_WITH_PAGE) return `这一页的数据连同问题超过 ${MAX_WITH_PAGE} 字符，没有发出`;
  return null;
}

export function splitPageContext(raw: string): { question: string; context: string } {
  const i = raw.lastIndexOf(PAGE_QUESTION_MARK);
  if (i >= 0) return { question: raw.slice(i + PAGE_QUESTION_MARK.length), context: raw.slice(0, i) };
  const m = raw.match(CONSOLE_PREFIX_RE);
  if (m) return { question: raw.slice(m[0].length), context: m[0] };
  return { question: raw, context: "" };
}
