import { workspaceRoot } from "@/lib/workspace";
/**
 * 固定在右上角的 AI 入口 —— **每一页都有**，点开就聊这一页。
 *
 * 以前是每个页面各挂一个「问 AI」按钮：只有想起来加的那五页有，其余七页没有。
 * 现在按钮由外壳渲染一份、位置固定，页面只负责**登记自己的上下文**（见 pageContext.tsx）。
 *
 * 🔴 这是 Core：它不认识任何行业。文案、免责声明、回答下面挂什么按钮、怎么连后端，
 *    全部由垂类通过 props 注入。换个行业只换注入的那一份。
 *
 * 对话本身的正确性（半截回答 / 换页竞态 / 后端 session 归属）在 `useAiChat` 里，
 * **与底部控制台共用同一份** —— 那些坑复制两遍必然有一份先坏，而且坏了看不出来。
 */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkles, Trash2, X } from "lucide-react";

import { cn } from "../lib/cn";
import { AiComposer, AiMessages } from "./AiMessages";
import { draftFor, useAiDraftInbox, useAiWired, useCurrentAiPage } from "./pageContext";
import { type AiSend, useAiChat } from "./useAiChat";

export interface AiDockCopy {
  /** 按钮上的字 */
  trigger: string;
  /** 面板标题 */
  panel: string;
  /** 输入框占位 */
  placeholder: string;
  /** 空对话时那条说明（免责声明一类，行业相关） */
  notice: string;
  /** 运行时身份，例如 Claude Code · 本地运行 */
  runtime?: string;
}

export interface AiDockProps {
  /** 发一轮（session 按对话分开，见 useAiChat.sessionId） */
  send: AiSend;
  /** 模型配好了没；没配就只显示引导 */
  configured: boolean;
  copy: AiDockCopy;
  /** 每条回答下面挂什么（例如"存进记录"）。Core 不认识这些，垂类给 */
  renderReplyActions?: (reply: string, question: string) => ReactNode;
  renderReply?: (reply: string) => ReactNode;
  /**
   * 没配模型时那条引导。**由垂类渲染**，因为它要用垂类的路由组件跳设置页 ——
   * Core 这边写个 `<a href>` 会让单页应用整页重载。
   */
  renderSetup?: () => ReactNode;
  /**
   * 显示前把文字换一下（例如隐私模式下打码）。**只改屏幕上的样子**：
   * 发送、保存、复制用的都是原文。垂类给规则，Core 不认识里面的词。
   */
  displayText?: (text: string) => string;
}

/** 浮动按钮和外壳右上角其它按钮之间留的空 */
const TRIGGER_GAP = 12;

export function AiDock({ send, configured, copy, renderReplyActions, renderReply, renderSetup, displayText }: AiDockProps) {
  const wired = useAiWired();
  const page = useCurrentAiPage();
  const [open, setOpen] = useState(false);
  // 按钮浮在外壳顶栏的右上角。外壳按 `--ai-trigger-space`（按钮实际宽度 + 间隔）给它让位，按钮不在就是 0。
  // 原来外壳写死让 112px:手机系统字体放大 1.3 倍时只剩 1px,再大就压住旁边的按钮;文案改长也一样。
  const triggerRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const root = workspaceRoot();
    const apply = () => root.style.setProperty("--ai-trigger-space", `${Math.ceil(el.getBoundingClientRect().width) + TRIGGER_GAP}px`);
    apply();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty("--ai-trigger-space"); };
  }, []);
  const chat = useAiChat(page?.key ?? "", send);
  const { abort } = chat;
  const pageKey = page?.key ?? "";
  // 输入框里的字记在哪一页名下：换了页就不再显示上一页没发出去的字
  const [input, setInput] = useState({ key: "", text: "" });
  const text = input.key === pageKey ? input.text : "";
  const setText = useCallback((t: string) => setInput({ key: pageKey, text: t }), [pageKey]);

  // 页面放进来的文字（useAiDraft）：打开面板、填进输入框，**不替用户发送**
  const [draft, takeDraft] = useAiDraftInbox();
  useEffect(() => {
    if (!draft) return;
    takeDraft(draft.seq);
    const t = draftFor(draft, pageKey);
    if (t === null) return;
    setInput({ key: pageKey, text: t });
    setOpen(true);
  }, [draft, pageKey, takeDraft]);

  const close = useCallback(() => {
    abort();
    setOpen(false);
  }, [abort]);

  // 面板开着时 Esc 关掉（弹层的基本预期）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // 每轮都把本页内容带上：后端那条线程是进程内的，服务重启后它什么都不记得，
  // 而用户不会知道服务重启过 —— 带着上下文问，重启前后都答得上来。
  // 🔴 登记了页面但上下文是空串时,**要说出来**,不能发一个裸问题:
  //    那样模型会凭自己的知识答一段看着正常的话,而用户以为它读的是这一页的数据。
  const decorate = (q: string) => {
    if (!page) return q;                       // 按钮本就点不动,兜底而已
    const body = page.context
      ? page.context
      : "（这一页的数据还没取到 / 是空的。请如实说明看不到本页数据，不要凭一般知识作答。）";
    return `【当前页面：${page.title}】\n${body}\n\n【问题】\n${q}`;
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        disabled={!page}
        title={
          !wired ? "AI 入口没接上（AiPageProvider 未挂载）"
            : page ? `${copy.trigger} · ${page.title}${page.context ? "" : "（本页数据还没取到）"}`
            : "这一页还没有可聊的内容"
        }
        className={cn(
          "ai-chat-trigger fixed right-4 top-2 z-40 inline-flex h-7 items-center gap-1.5 rounded-md px-3",
          "text-[12.5px] font-medium transition-colors",
          !page && "cursor-not-allowed",
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {copy.trigger}
      </button>

      {open && page && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={close} />
          <aside className="ai-surface relative m-3 flex w-full max-w-md flex-col rounded-2xl overflow-hidden">
            <div className="ai-surface-header flex items-center justify-between gap-2 border-b border-border/60 p-4">
              <div className="min-w-0">
                <span className="flex min-w-0 items-center gap-2 font-semibold">
                  <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate">{copy.panel} · {page.title}</span>
                </span>
                {copy.runtime && (
                  <span data-agent-runtime className="mt-1 flex items-center gap-1.5 pl-6 text-[10px] font-medium tracking-wide text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_7px_hsl(var(--success)/0.65)]" />
                    {copy.runtime}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {chat.msgs.length > 0 && (
                  <button onClick={chat.clear} title="清空本页对话" aria-label="清空本页对话"
                    className="text-muted-foreground hover:text-foreground">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                <button onClick={close} aria-label="关闭" className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {!configured ? (
              <div className="flex-1 space-y-4 overflow-auto p-4 text-sm">
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  {copy.notice}
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">将随提问发给 AI 的本页内容：</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
{displayText ? displayText(page.context) : page.context}
                  </pre>
                </div>
                {renderSetup?.()}
              </div>
            ) : (
              <>
                <AiMessages
                  msgs={chat.msgs}
                  loading={chat.loading}
                  err={chat.err}
                  info={chat.info}
                  renderReply={renderReply}
                  notice={copy.notice}
                  suggestions={page.suggestions}
                  onPick={(x) => void chat.submit(x, decorate)}
                  renderReplyActions={renderReplyActions}
                  displayText={displayText}
                />
                <AiComposer
                  placeholder={copy.placeholder}
                  value={text}
                  onValueChange={setText}
                  disabled={chat.loading}
                  onStop={chat.loading ? chat.abort : undefined}
                  onSend={(t) => void chat.submit(t, decorate)}
                />
              </>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
