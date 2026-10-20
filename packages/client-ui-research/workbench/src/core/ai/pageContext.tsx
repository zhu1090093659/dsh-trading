/**
 * 「当前这一页要给 AI 看什么」的登记处。
 *
 * 以前每个页面**自己**渲染一个「问 AI」按钮，于是只有想起来加的那几页有。
 * 现在按钮固定在右上角、由外壳渲染一份 —— 外壳就必须有办法知道"用户现在看的是哪一页"。
 * ⇒ 页面只**登记**自己的上下文，按钮从这里读。
 *
 * 🔴 这一层是 Core：它不认识任何行业，只搬运页面给的字符串。
 *    上下文写什么、建议问什么，全由垂类的页面决定。
 */
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface AiPage {
  /**
   * 这份对话的归属。**换页 / 换对象都要换 key**，否则上一页的历史会被当成
   * history 发给问下一页的模型（问 A 的记录出现在 B 的对话里）。
   */
  key: string;
  /** 面板上显示的"在聊哪一页" */
  title: string;
  /** 随提问一起发给模型的本页数据 */
  context: string;
  /** 空对话时给几个可点的问题 */
  suggestions?: string[];
}

interface Store {
  page: AiPage | null;
  set: Dispatch<SetStateAction<AiPage | null>>;
}

const Ctx = createContext<Store | null>(null);

/** 页面放进 AI 输入框的一段文字。seq 区分「同一段文字又点了一次」；key 记着是哪一页放的 */
export interface AiDraft {
  text: string;
  seq: number;
  key: string;
}

interface DraftStore {
  draft: AiDraft | null;
  put: (text: string) => void;
  take: (seq: number) => void;
}

// 和页面上下文分开放：放一段文字不该让每个登记上下文的页面跟着重渲染
const DraftCtx = createContext<DraftStore | null>(null);
const noTake = () => {};

export function AiPageProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<AiPage | null>(null);
  const value = useMemo<Store>(() => ({ page, set: setPage }), [page]);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const seq = useRef(0);
  const pageKey = page?.key ?? "";
  const put = useCallback((text: string) => {
    seq.current += 1;
    setDraft({ text, seq: seq.current, key: pageKey });
  }, [pageKey]);
  const take = useCallback((n: number) => setDraft((d) => (d?.seq === n ? null : d)), []);
  const drafts = useMemo<DraftStore>(() => ({ draft, put, take }), [draft, put, take]);
  return (
    <Ctx.Provider value={value}>
      <DraftCtx.Provider value={drafts}>{children}</DraftCtx.Provider>
    </Ctx.Provider>
  );
}

/**
 * 页面把一段文字放进 AI 入口的输入框：面板打开、文字填好，**不自动发送** ——
 * 用户看过、改过，自己点发送（发出去会用掉用户 AI 的额度，不能替他点）。
 * 没挂 Provider 时返回 null，调用方据此把按钮藏起来，而不是点了没反应。
 */
export function useAiDraft(): ((text: string) => void) | null {
  return useContext(DraftCtx)?.put ?? null;
}

/**
 * 收到的文字填不填进当前这一页的输入框：只填这一页放的。
 * 放的时候入口没挂着、换了页才收到的，返回 null（丢掉）—— 不能填进另一页的对话。
 */
export function draftFor(draft: AiDraft | null, pageKey: string): string | null {
  return draft && pageKey && draft.key === pageKey ? draft.text : null;
}

/** AI 入口这边收件：拿到后调 take(seq) 收走，免得下次渲染又填一遍 */
export function useAiDraftInbox(): [AiDraft | null, (seq: number) => void] {
  const ctx = useContext(DraftCtx);
  return [ctx?.draft ?? null, ctx?.take ?? noTake];
}

/**
 * 外壳有没有接上（`AiPageProvider` 挂了没有）。
 * 🔴 分开报,是因为"没接上"和"这页没内容"在界面上长得一模一样 ——
 *    都是按钮灰掉 + 一句"没有可聊的内容"。**把接线故障伪装成内容为空**,
 *    排查时会一路去查页面数据,而根因在路由层漏挂了 Provider。
 */
export function useAiWired(): boolean {
  return useContext(Ctx) !== null;   // 默认值是 null（createContext<Store | null>(null)），不是 undefined
}

export function useCurrentAiPage(): AiPage | null {
  const ctx = useContext(Ctx);
  if (ctx === null && import.meta.env.DEV) {
    // 开发期直接炸:漏挂 Provider 是接线 bug,不该等到线上才发现
    throw new Error("AiPageProvider 没有挂上 —— AI 入口读不到页面上下文");
  }
  return ctx?.page ?? null;
}

/**
 * 页面登记自己的上下文。传 `null` = 这一页暂时没什么可聊的（按钮会变成不可点，
 * 而不是消失 —— 时有时无的按钮会被当成坏了）。
 *
 * 🔴 依赖按**内容**比，不按对象比：`context` 每次渲染都是新拼的字符串，
 *    把对象直接放进依赖数组会每帧 setState 一次 —— 死循环，而且表现只是"有点卡"。
 * 🔴 卸载时**只清掉自己登记的那份**：无条件清空会在"旧页卸载晚于新页挂载"的切页顺序里
 *    把新页刚登记的上下文抹掉，表现是换页之后 AI 说"这页没有数据"。
 * `enabled = false`：这一块挂着但没在看（例如藏起来的分页），既不登记也不清，交给正在看的那块。
 */
export function useAiPage(page: AiPage | null, enabled = true): void {
  const ctx = useContext(Ctx);
  if (ctx === null && import.meta.env.DEV) {
    throw new Error("AiPageProvider 没有挂上 —— 页面登记的上下文会被丢掉");
  }
  const set = ctx?.set;
  const mine = useRef<AiPage | null>(null);

  const has = page !== null;
  const key = page?.key ?? "";
  const title = page?.title ?? "";
  const context = page?.context ?? "";
  // 只为比较用：把建议压成一个字符串，免得数组每次都是新对象
  const sig = page?.suggestions?.join("\u0000") ?? "";

  useEffect(() => {
    if (!set || !enabled) return;
    const next: AiPage | null = has
      ? { key, title, context, suggestions: sig ? sig.split("\u0000") : [] }
      : null;
    mine.current = next;
    set(next);
    return () => {
      set((prev) => (prev === mine.current ? null : prev));
    };
  }, [set, enabled, has, key, title, context, sig]);
}
