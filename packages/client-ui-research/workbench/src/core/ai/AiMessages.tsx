/**
 * 对话气泡区 —— 抽屉与底部控制台共用这一份渲染。
 *
 * 🔴 回答按 markdown 渲染、提问按纯文本：模型答的是带 **加粗**、列表、表格的正文，
 *    当纯文本贴出来就是一屏星号（看着像模型答坏了，其实是没渲染）；
 *    而用户打的字里出现 markdown 记号是巧合，不该被解释成格式。
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { noRemoteImages } from "./noRemoteImages";
import { cleanAutoLinks } from "./cleanAutoLinks";

import { cn } from "../lib/cn";
import type { AiMsg } from "./useAiChat";

export interface AiMessagesProps {
  msgs: AiMsg[];
  loading: boolean;
  err: string | null;
  info?: string | null;
  renderReply?: (reply: string) => ReactNode;
  /** 空对话时那条说明（免责声明一类，行业相关，由垂类给） */
  notice?: string;
  /** 空对话时可点的问题 */
  suggestions?: string[];
  /** 长任务用两列任务卡；短问题继续用紧凑胶囊。 */
  suggestionStyle?: "pills" | "tasks";
  onPick?: (s: string) => void;
  /** 每条回答下面挂什么（例如"存进记录"）。Core 不认识这些，垂类给 */
  renderReplyActions?: (reply: string, question: string) => ReactNode;
  /**
   * 显示前把文字换一下（例如隐私模式下打码）。**只改屏幕上的样子**：
   * 发送、保存、复制用的都是原文。垂类给规则，Core 不认识里面的词。
   */
  displayText?: (text: string) => string;
  className?: string;
}

export function AiMessages({
  msgs, loading, err, info, renderReply, notice, suggestions = [], suggestionStyle = "pills", onPick, renderReplyActions, displayText, className,
}: AiMessagesProps) {
  const show = displayText ?? ((t: string) => t);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  return (
    <div ref={ref} className={cn("flex-1 space-y-3 overflow-auto p-4 text-sm", className)}>
      {msgs.length === 0 && notice && (
        <div data-ai-notice className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
          {notice}
        </div>
      )}
      {msgs.map((m, i) => (
        <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
          <div className={cn(
            "max-w-[85%] rounded-2xl px-3 py-2 leading-relaxed",
            m.role === "user" ? "ai-message-user bg-primary/20 text-foreground" : "ai-message-assistant bg-muted/40 text-foreground",
          )}>
            {m.role === "assistant" ? (
              <div className="prose prose-sm dark:prose-invert max-w-none break-words text-foreground">
                {renderReply ? renderReply(show(m.content)) : <ReactMarkdown remarkPlugins={[remarkGfm, cleanAutoLinks]} components={noRemoteImages}>{show(m.content)}</ReactMarkdown>}
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words">{show(m.content)}</p>
            )}
            {m.role === "assistant" && m.content && !(loading && i === msgs.length - 1) &&
              renderReplyActions?.(m.content, msgs[i - 1]?.content ?? "")}
          </div>
        </div>
      ))}
      {loading && <AiWaiting />}
      {info && <p role="status" className="rounded-lg border border-border bg-muted/20 p-2 text-xs text-muted-foreground">{info}</p>}
      {err && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {err}
        </div>
      )}
      {msgs.length === 0 && suggestions.length > 0 && (
        <div className={cn(
          "pt-1",
          suggestionStyle === "tasks" ? "grid gap-2 sm:grid-cols-2" : "flex flex-wrap gap-1.5",
        )}>
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => onPick?.(s)}
              className={cn(
                "border border-border bg-muted/35 text-xs transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary",
                suggestionStyle === "tasks"
                  ? "rounded-xl px-3 py-2.5 text-left leading-5"
                  : "rounded-full px-2.5 py-1",
              )}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Wall-clock waiting only: do not infer model activity or invent completion percentages. */
export function AiWaiting() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="text-xs text-muted-foreground">
    <p className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />等待回答<span aria-live="off"> · 已等待 {seconds} 秒</span></p>
    {seconds >= 20 && <p role="status" className="mt-1">尚未收到回答。耗时取决于模型与工具调用，可停止等待后缩小问题范围。</p>}
  </div>;
}

/** 输入条：两个外壳共用（Enter 发送、Shift+Enter 换行） */
export function AiComposer({
  placeholder, disabled, onSend, onStop, highlighted = false, value, onValueChange,
}: {
  placeholder: string;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  highlighted?: boolean;
  /** 传 value 时变成受控输入；首页用它把任务模板先填进来，而不是点击即发送。 */
  value?: string;
  onValueChange?: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fire = () => {
    const v = value ?? ref.current?.value ?? "";
    if (!v.trim() || disabled) return;
    onSend(v);
    if (value !== undefined) onValueChange?.("");
    else if (ref.current) ref.current.value = "";
  };
  return (
    <div className={cn(
      "ai-composer border-t p-3",
      highlighted ? "border-warning/30 bg-warning/[0.035]" : "border-border/60",
    )}>
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          onKeyDown={(e) => {
            // 🔴 中文输入法**选字期间**的 Enter 是"确认候选词"，不是"发送"。
            //    不挡的话，打到一半按回车会把没成词的拼音直接发出去并清空输入框 ——
            //    对中文用户是每天都会撞到的。`isComposing` 只在原生事件上有。
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              fire();
            }
          }}
          // 填进来的长文字（任务模板、分步提示词）要看得见再发：按行数撑高，最多 8 行，再多就滚动
          rows={value ? Math.min(8, value.split("\n").length) : 1}
          value={value}
          onChange={(e) => onValueChange?.(e.currentTarget.value)}
          placeholder={placeholder}
          className={cn(
            "ai-input min-w-0 flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
            highlighted
              ? "border-warning/45 bg-warning/[0.075] placeholder:text-muted-foreground focus:border-warning/70 focus:bg-warning/[0.11]"
              : "border-border bg-background/55 focus:border-primary/50 focus:bg-background/75",
          )}
        />
        {onStop ? <button type="button" onClick={onStop}
          className="ai-send shrink-0 rounded-lg border border-primary/40 px-3 py-2 text-primary hover:bg-primary/15">
          停止
        </button> : <button type="button" onClick={fire} disabled={disabled}
          className="ai-send shrink-0 rounded-lg bg-primary/15 px-3 py-2 text-primary hover:bg-primary/25 disabled:opacity-40">
          发送
        </button>}
      </div>
      {onStop && <p className="mt-2 text-[11px] text-muted-foreground">可先写下一问，当前回答结束后手动发送；草稿不会自动提交。</p>}
    </div>
  );
}
