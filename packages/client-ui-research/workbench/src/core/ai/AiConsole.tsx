import { workspaceStorage } from "@/lib/workspace";
/**
 * 底部 AI 控制台 —— 从下面推上来的一块，**不是盖在内容上的浮层**。
 *
 * 与右上角那个「按页问」的区别：
 * - 右上角 = 问**这一页**，对话跟着页面走，换页就是另一份记录；
 * - 这里   = 一条**长期**的对话，跟着你翻页一起走，聊什么都行。
 *
 * 🔴 打开时把主内容区**挤上去**，而不是浮在上面：浮层会把用户正在看的表格盖住，
 *    而这块面板的用处恰恰是"一边看着页面一边聊"。⇒ 由外壳用 flex 布局挤，
 *    这个组件只管自己那一块高度。
 * 🔴 这是 Core：不认识任何行业，文案与后端都由垂类注入。
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MessageSquarePlus, Sparkles, Trash2, X } from "lucide-react";

import { cn } from "../lib/cn";
import { AiComposer, AiMessages } from "./AiMessages";
import { useCurrentAiPage } from "./pageContext";
import { type AiThread, directoryReadable, listThreads, newThreadId, removeThread, touchThread, whenLabel } from "./threads";
import { type AiSend, useAiChat } from "./useAiChat";

const MIN_H = 220;
const MAX_H_RATIO = 0.8;
const DEFAULT_H = 340;
const HEIGHT_KEY = "vr-ai-console-h";

export interface AiConsoleCopy {
  title: string;
  placeholder: string;
  notice: string;
  runtime?: string;
  suggestions?: string[];
}

export interface AiConsoleProps {
  open: boolean;
  onClose: () => void;
  send: AiSend;
  configured: boolean;
  copy: AiConsoleCopy;
  renderReplyActions?: (reply: string, question: string) => ReactNode;
  renderReply?: (reply: string) => ReactNode;
  renderSetup?: () => ReactNode;
  /**
   * 显示前把文字换一下（例如隐私模式下打码）。**只改屏幕上的样子**：
   * 发送、保存、复制用的都是原文。垂类给规则，Core 不认识里面的词。
   */
  displayText?: (text: string) => string;
}

const readH = (): number => {
  try {
    const v = Number(workspaceStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_H ? v : DEFAULT_H;
  } catch {
    return DEFAULT_H;
  }
};

export function AiConsole({ open, onClose, send, configured, copy, renderReplyActions, renderReply, renderSetup, displayText }: AiConsoleProps) {
  const page = useCurrentAiPage();
  /**
   * 聊天记录：左边一栏是**历次对话**，右边是当前这条。
   * 🔴 一进来落在最近聊过的那条上（不是每次都开新的）—— 否则昨天聊到一半的东西
   *    要先在列表里翻一遍才能接着聊，而多数时候你就是想接着上次说。
   */
  const [threads, setThreads] = useState<AiThread[]>(listThreads);
  const [threadId, setThreadId] = useState(() => listThreads()[0]?.id ?? newThreadId());
  const chat = useAiChat(threadId, send);
  const [height, setHeight] = useState(readH);
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  // 🔴 落盘要用**最后一次算出来的**高度：`mouseup` 拿的是 effect 闭包里的 `height`，
  //    而最后一次 mousemove 的 setState 可能还没提交 —— 屏幕上已经是新高度，
  //    存进去的却是上一帧的旧值，下次打开就"回弹"一点点，看不出是 bug。
  const hRef = useRef(height);
  hRef.current = height;
  /** `chat.msgs` 现在属不属于选中的这条。换条那一帧是 false —— 那一帧的内容是**上一条的**。 */
  const inSync = chat.key === threadId;

  /**
   * 有内容了就把这条记进目录（标题取第一句话）。
   * ⚠️ 看的是消息本身，不是"这一轮成没成功"：问过了就是问过了 —— 哪怕这轮没答上来，
   *    也该能在列表里找回自己问过什么。
   */
  const firstAsk = chat.msgs.find((m) => m.role === "user")?.content ?? "";
  const turns = chat.msgs.length;
  const msgsKey = chat.key;
  useEffect(() => {
    // 🔴 `msgsKey !== threadId` 那一帧必须跳过：点「新对话」之后 threadId 已经换了，
    //    而 msgs 还是上一条的（state 下一帧才生效）—— 不挡的话，新对话会被写上
    //    **上一条的标题**，列表里出现两条一模一样的名字（真踩过）。
    if (!firstAsk || msgsKey !== threadId) return;
    setThreads(touchThread(threadId, firstAsk));
  }, [threadId, msgsKey, firstAsk, turns]);

  // 拖上边框改高度。⚠️ 监听挂在 window 上：鼠标很容易划出那条几像素的把手，
  // 只在把手上监听的话，拖快一点就"拖丢了"。
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(Math.max(d.h + (d.y - e.clientY), MIN_H), window.innerHeight * MAX_H_RATIO);
      hRef.current = next;
      setHeight(next);
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        workspaceStorage.setItem(HEIGHT_KEY, String(hRef.current));
      } catch {
        /* 存不下就下次回默认高度，不影响用 */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // 高度经 hRef 读，不放依赖 —— 放了会每帧重挂监听
  }, []);

  const { abort } = chat;
  const close = useCallback(() => {
    abort();
    onClose();
  }, [abort, onClose]);

  const startNew = () => {
    abort();
    setThreadId(newThreadId()); // 还没说话就不进目录 —— 空条目没人想在列表里看到
  };

  const dropThread = (id: string) => {
    const left = removeThread(id);
    setThreads(left);
    // 删掉的正好是当前这条 ⇒ 落到最近的一条上，没有就开新的
    // （不这么做的话，当前 threadId 会指向一份已经被删掉的对话，页面上是空的但也不报错）
    if (id === threadId) setThreadId(left[0]?.id ?? newThreadId());
  };

  if (!open) return null;

  /**
   * 把"用户当前在看哪一页"作为一句背景带上 —— 但**只带标题不带整页数据**：
   * 这是一条长期对话，每轮都塞一整页数据会把它越喂越胖，而且在这儿问的经常与当前页面无关。
   * 要就着页面数据问，右上角那个入口才是干这个的。
   */
  const decorate = (q: string) => (page ? `（我正在看「${page.title}」这一页）\n${q}` : q);

  return (
    <section
      style={{ height }}
      className="ai-surface relative z-30 flex shrink-0 flex-col overflow-hidden rounded-t-2xl border-t border-primary/30"
    >
      {/* 拖拽把手 */}
      <div
        onMouseDown={(e) => {
          dragRef.current = { y: e.clientY, h: height };
        }}
        title="拖动改变高度"
        className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize hover:bg-primary/30"
      />
      <div className="ai-surface-header flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate">{copy.title}</span>
          {copy.runtime && (
            <span data-agent-runtime className="hidden items-center gap-1.5 rounded-full border border-success/20 bg-success/[0.07] px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_7px_hsl(var(--success)/0.65)]" />
              {copy.runtime}
            </span>
          )}
          {page && (
            <span className="truncate text-xs font-normal text-muted-foreground">· 你正在看「{page.title}」</span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {inSync && chat.msgs.length > 0 && (
            <button onClick={chat.clear} title="清空当前这条对话" aria-label="清空当前这条对话"
              className="text-muted-foreground hover:text-foreground">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button onClick={close} aria-label="收起" title="收起"
            className="text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!configured ? (
        <div className="flex-1 space-y-3 overflow-auto p-4 text-sm">
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
            {copy.notice}
          </div>
          {renderSetup?.()}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：聊天记录。**自己一条滚动轴** —— 记录多了以后，翻记录不该把右边的对话一起滚走 */}
          <aside className="flex w-48 shrink-0 flex-col border-r border-border/60">
            <button
              onClick={startNew}
              className="m-2 flex items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> 新对话
            </button>
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
              {/* 目录读不出来（存储里的数据坏了）≠ 没聊过：别说「还没有记录」，之前的对话内容还在（第四轮审计 D3） */}
              {threads.length === 0 && (
                <p className="px-1 py-2 text-[11px] leading-relaxed text-muted-foreground/60">
                  {directoryReadable()
                    ? "还没有记录。聊过的对话会按时间排在这儿，随时点回去接着聊。"
                    : "聊天记录的目录暂时读不出来（浏览器里存的数据格式不对），之前的对话内容没有删。"}
                </p>
              )}
              {threads.map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "group mb-1 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors",
                    t.id === threadId ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  <button onClick={() => setThreadId(t.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{t.title ? (displayText ? displayText(t.title) : t.title) : "（空对话）"}</span>
                    <span className="block text-[10px] text-muted-foreground/60">{whenLabel(t.updatedAt)}</span>
                  </button>
                  <button
                    onClick={() => dropThread(t.id)}
                    title="删掉这条记录"
                    aria-label="删掉这条记录"
                    className="shrink-0 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </aside>

          {/* 右：当前这条对话 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* 🔴 换条那一帧 msgs 还是上一条的 —— 门控住，否则旧消息会显示在新选中的
                条目下，而且此刻还能发送 / 清空，等于对着错的那条动手。 */}
            <AiMessages
              msgs={inSync ? chat.msgs : []}
              loading={chat.loading || !inSync}
              err={chat.err}
              info={chat.info}
              renderReply={renderReply}
              notice={copy.notice}
              suggestions={copy.suggestions}
              onPick={(x) => inSync && void chat.submit(x, decorate)}
              renderReplyActions={renderReplyActions}
              displayText={displayText}
            />
            <AiComposer
              placeholder={copy.placeholder}
              disabled={chat.loading || !inSync}
              onStop={chat.loading && inSync ? chat.abort : undefined}
              onSend={(t) => inSync && void chat.submit(t, decorate)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
