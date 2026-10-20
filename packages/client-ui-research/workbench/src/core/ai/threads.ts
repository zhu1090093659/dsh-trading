import { workspaceStorage } from "@/lib/workspace";
/**
 * 底部控制台的**聊天记录**：一条条历史对话，能翻回去看。
 *
 * 每条对话的消息本身仍由 `useAiChat` 按 key 存（`vr-ai-chat:<id>`）；
 * 这里只管**目录**：有哪些对话、叫什么、最近什么时候聊的。
 *
 * 🔴 目录与内容是两份数据，删的时候**必须一起删** —— 只删目录会留下永远读不到的孤儿，
 *    只删内容会留下点开是空的条目。所以删除只走这里的 `removeThread`。
 */
import { dropChat } from "./useAiChat";

const LIST_KEY = "vr-ai-threads";
/** 目录里最多留这么多条。**只裁目录不动内容会留下孤儿** ⇒ 裁掉的同时把内容也删了 */
const MAX_THREADS = 50;
const TITLE_MAX = 40;

export interface AiThread {
  id: string;
  title: string;
  /** 毫秒时间戳 */
  updatedAt: number;
}

/**
 * 读目录的结果。
 * 🔴 **"真的空" 与 "读不出来" 必须分开**：两者都返回 `[]` 的话，下一次
 *    `touchThread` 会把目录写成只剩当前这一条 —— 之前那些对话的**内容还在**，
 *    但目录里没有了，永远读不到。这是静默数据丢失，而界面只表现为"记录变少了"。
 */
type ReadResult =
  | { ok: true; list: AiThread[] }
  | { ok: false; why: "corrupt" | "unavailable" };

const isThread = (t: unknown): t is AiThread =>
  !!t && typeof t === "object" &&
  typeof (t as AiThread).id === "string" &&
  typeof (t as AiThread).title === "string" &&
  typeof (t as AiThread).updatedAt === "number";

const readResult = (): ReadResult => {
  let raw: string | null;
  try {
    raw = workspaceStorage.getItem(LIST_KEY);
  } catch {
    return { ok: false, why: "unavailable" };   // 隐私模式 / WebView 故障：**不是**空目录
  }
  // 🔴 只有 `null` 才是"还没建过目录"。空字符串是**写坏了**——
  //    当成空目录的话，下一次写入会把整份目录覆盖掉。
  if (raw === null) return { ok: true, list: [] };
  if (raw === "") return { ok: false, why: "corrupt" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, why: "corrupt" };
    // 🔴 **不能 filter 掉格式异常的条目再往下走**：过滤后的结果会被写回去，
    //    那些条目的入口就永久没了，而它们的对话内容还躺在存储里。
    //    有一条不认识 = 整份目录当损坏，什么都别写。
    if (!parsed.every(isThread)) return { ok: false, why: "corrupt" };
    return { ok: true, list: parsed };
  } catch {
    return { ok: false, why: "corrupt" };
  }
};

/** 读不出来时给空数组供界面渲染 —— 但**写路径不能用它**，要用 readResult。 */
const read = (): AiThread[] => {
  const r = readResult();
  return r.ok ? r.list : [];
};

/** 目录当前读不读得出来。界面可以据此提示"记录暂时读不到"，而不是显示成"没有记录"。 */
export function directoryReadable(): boolean {
  return readResult().ok;
}

/** 写目录。**返回是否成功** —— 调用方要据此决定删不删内容。 */
const write = (list: AiThread[]): boolean => {
  try {
    workspaceStorage.setItem(LIST_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;   // 配额满 / 隐私模式：这次没记住
  }
};

/** 按最近聊过的排前面 */
export function listThreads(): AiThread[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function newThreadId(): string {
  // 不用 crypto.randomUUID：老 WebView 上没有，而这里只需要"不重"，不需要密码学强度
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 记一笔"这条对话刚聊过"。`title` 只在**还没有标题时**写入 ——
 * 用第一句话当标题，后面再聊也不改，免得列表里的名字一直在变、找不回昨天那条。
 */
export function touchThread(id: string, title: string, now = Date.now()): AiThread[] {
  const cur = readResult();
  // 🔴 读不出来就**什么都不写**。照空数组写回去，会把目录压成只剩这一条，
  //    而之前那些对话的内容还躺在 workspaceStorage 里、再也找不到入口。
  if (!cur.ok) return [];
  const list = cur.list;
  const i = list.findIndex((t) => t.id === id);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  if (i >= 0) {
    list[i] = { ...list[i]!, updatedAt: now, title: list[i]!.title || clean };
  } else {
    list.push({ id, title: clean, updatedAt: now });
  }
  const kept = list.sort((a, b) => b.updatedAt - a.updatedAt);
  const head = kept.slice(0, MAX_THREADS);
  // 🔴 **先提交目录，成功了再删内容**。反过来的话，目录写失败（配额满 / 隐私模式）时
  //    内容已经没了，旧目录还留着那些条目 —— 点开是一片空白，而且看不出内容已丢。
  if (!write(head)) return kept;   // 没写成：目录仍是旧的，内容一个都别动
  for (const gone of kept.slice(MAX_THREADS)) dropChat(gone.id);
  return head;
}

export function removeThread(id: string): AiThread[] {
  const cur = readResult();
  if (!cur.ok) return [];                       // 同上：读不出来就不动任何东西
  const left = cur.list.filter((t) => t.id !== id);
  // 同 touchThread：先提交目录，成功了才删内容
  if (!write(left)) return cur.list.sort((a, b) => b.updatedAt - a.updatedAt);
  dropChat(id);
  return left.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 列表上显示的相对时间。**只到"天"** —— 更细的精度对"翻回去找那条"没有帮助 */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = Math.floor((now - ts) / 86400000);
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
