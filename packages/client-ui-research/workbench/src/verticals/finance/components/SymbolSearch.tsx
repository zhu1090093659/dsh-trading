import { workspaceRoot } from "@/lib/workspace";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search } from "lucide-react";

import { backend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import type { MarketCode } from "@/lib/marketSymbol";
import { MARKET_TAG, liveMatches, matchTag, parseSearch, searchKey, type SearchResult, type SymbolMatch } from "@/lib/symbolSearch";

/** 联想结果缓存十分钟：同一个词来回改不必每次都等东财限流（每次约 1 秒）。 */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; matches: SymbolMatch[] }>();
const DEBOUNCE_MS = 300;
/** 下拉最高 18rem；输入框下方不够这么高、上方更宽裕时往上弹 */
const DROP_MAX_PX = 288;

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 用户从下拉里选了一个（输入框会被换成规范代码） */
  onPick?: (m: SymbolMatch) => void;
  /** 下拉没开时按回车（页面原来的「回车开始」） */
  onEnter?: () => void;
  /** 只要某几个市场的候选，如多空辩论只支持 A 股 */
  markets?: MarketCode[];
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * 四个页面共用的搜索框：代码、中文名、拼音首字母都能找（gzmt / 茅台 / 600519）。
 * 搜不通时不挡路：照样可以直接输入代码，下面一行说明原因。
 */
export function SymbolSearch({ value, onChange, onPick, onEnter, markets, placeholder, title, disabled, className, ariaLabel }: Props) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const matches = liveMatches(result, value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<SymbolMatch | null>(null);
  const ctl = useRef<AbortController | null>(null);
  /** 搜索结果回来时只有输入框正拿着焦点才弹下拉:页面从链接带代码进来(没点输入框)时不弹,点进去再显示 */
  const focused = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const listId = useId();
  const marketKey = (markets ?? []).join(",");

  useEffect(() => {
    const q = value.trim();
    // 输入一变：上一个词的请求作废、下拉先收起（旧候选本身由 liveMatches 按词作废）
    ctl.current?.abort();
    ctl.current = null;
    setLoading(false);
    setOpen(false);
    // 刚选中的那一个不再弹下拉；清空也不搜
    if (!q || (picked && picked.symbol === q)) { setResult(null); return; }
    const key = searchKey(q);
    const keep = (ms: SymbolMatch[]) => (markets?.length ? ms.filter((m) => markets.includes(m.market)) : ms);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) { setResult({ query: key, matches: keep(hit.matches) }); setHi(0); setOpen(focused.current); setError(""); return; }
    const t = setTimeout(() => {
      const c = new AbortController();
      ctl.current = c;
      setLoading(true);
      backend.runTool<unknown>("search", { query: q }, c.signal)
        .then((out) => {
          if (c.signal.aborted) return;
          const r = parseSearch(out);
          if (!r.ok) { setError(r.error); setResult(null); setOpen(false); return; }
          cache.set(key, { at: Date.now(), matches: r.matches });
          setError(""); setResult({ query: key, matches: keep(r.matches) }); setHi(0); setOpen(focused.current);
        })
        .catch((e) => { if (!c.signal.aborted) { setError(`名称搜索暂时不通（${e instanceof Error ? e.message : String(e)}），可以直接输入代码`); setOpen(false); } })
        .finally(() => { if (!c.signal.aborted) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // markets 用拼接后的字符串比较，页面每次渲染传新数组也不会重搜
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, picked, marketKey]);

  useEffect(() => () => ctl.current?.abort(), []);

  const pick = (m: SymbolMatch) => {
    setPicked(m);
    setOpen(false);
    onChange(m.symbol);
    onPick?.(m);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;   // 中文输入法选字时的回车不算
    if (open && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => (i + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter") { e.preventDefault(); pick(matches[hi] ?? matches[0]!); return; }
    }
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "Enter") { e.preventDefault(); onEnter?.(); }
  };

  const showName = picked && picked.symbol === value.trim() ? picked.name : "";
  const empty = open && !loading && !matches.length && value.trim().length > 0;
  const showList = open && matches.length > 0;

  // 🔴 下拉挂到 body 上、按输入框位置固定定位：卡片带毛玻璃（backdrop-filter）各自成层，
  //    下拉留在卡片里的话 z-index 再高也会被页面后面那张卡片盖住。
  useLayoutEffect(() => {
    if (!showList && !empty) { setPlace(null); return; }
    const update = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const bounds = workspaceRoot().getBoundingClientRect();
      const below = bounds.bottom - r.bottom;
      const up = below < DROP_MAX_PX && r.top - bounds.top > below;
      setPlace({
        position: "fixed", left: r.left - bounds.left, minWidth: Math.max(288, r.width),
        ...(up ? { bottom: bounds.bottom - r.top + 4 } : { top: r.bottom - bounds.top + 4 }),
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [showList, empty]);

  return (
    <div className={cn("relative", className)}>
      <div ref={box} className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          value={value}
          onChange={(e) => { onChange(e.target.value); if (picked && e.target.value.trim() !== picked.symbol) setPicked(null); }}
          onKeyDown={onKeyDown}
          onFocus={() => { focused.current = true; if (matches.length) setOpen(true); }}
          onBlur={() => { focused.current = false; setOpen(false); }}
          placeholder={placeholder}
          title={title}
          disabled={disabled}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-background/60 py-2 pl-8 pr-8 font-mono text-sm outline-none focus:border-primary/60"
        />
        {loading && <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {showName && <p className="mt-1 truncate text-[11px] text-muted-foreground">{showName}</p>}
      {error && !open && <p className="mt-1 text-[11px] leading-4 text-warning">{error}</p>}
      {showList && place && createPortal(
        <ul id={listId} role="listbox" style={place}
          className="z-50 max-h-72 overflow-auto rounded-lg border border-border bg-card p-1 shadow-xl">
          {matches.map((m, i) => (
            <li key={m.symbol} role="option" aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }}
              onMouseEnter={() => setHi(i)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", i === hi && "bg-muted/60")}>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{m.symbol}</span>
              <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground/80">{matchTag(m)}</span>
            </li>
          ))}
        </ul>,
        workspaceRoot(),
      )}
      {empty && place && createPortal(
        <div style={place} className="z-50 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-xl">
          {markets?.length ? `没找到${markets.map((m) => MARKET_TAG[m]).join(" / ")}里匹配的标的` : "没找到匹配的标的"}，也可以直接输入代码
        </div>,
        workspaceRoot(),
      )}
    </div>
  );
}
