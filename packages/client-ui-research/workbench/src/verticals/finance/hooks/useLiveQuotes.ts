// 自选股快照轮询，不是逐笔实时行情。
//
// 几个刻意的选择：
// - 每次明确要求 fresh，跳过产品的 5 分钟缓存；上游仍可能延迟。
// - 请求完成后等 3 秒再取，不承诺数据每 3 秒更新。
// - **递归 setTimeout 而不是 setInterval**：单次请求实测 ~750ms，网络一慢 setInterval
//   会让请求首尾叠在一起。改成「上一次结束后再等 N 秒」，永远不会堆叠。
// - **非交易时段自动暂停**：收盘后数据不再变化，继续轮询既无意义又给上游添压。
//   手动刷新按钮仍然可用。
// - **页面切走时暂停**：用户看不到的时候不该继续消耗流量（浏览器自身也会节流后台定时器）。
// - **失败退避**：连续失败时间隔翻倍（上限 30 秒），成功后立刻复位，避免断网时疯狂重试。

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Quote } from "@/lib/api";
import { isAnyMarketTrading, tradingMarketSymbols } from "@/lib/marketSymbol";
import { startPollLoop } from "@/lib/pollLoop";
import { mergePolledQuotes, quoteFailure, quoteSnapshotTime } from "@/lib/quoteSnapshot";

export const LIVE_INTERVAL_MS = 3000;
const MAX_BACKOFF_MS = 30_000;

/** 自选中任一市场开盘就轮询；空参数保留旧的 A 股语义。 */
export const isTradingHours = (codes: string[] = [], at = new Date()): boolean => isAnyMarketTrading(codes, at);

export interface LiveQuotesState {
  quotes: Record<string, Quote>;
  loading: boolean;
  /** 已显示价格中最早的源取数时刻（ms）；缺失时为 null */
  updatedAt: number | null;
  /** 轮询是否真的在跑（开关开着 ≠ 在跑：非交易时段 / 页面切走都会暂停） */
  polling: boolean;
  error: string | null;
  /**
   * 最近一次完整取数（首次 / 名单变化 / 手动刷新）取的是哪份名单（代码用逗号连起来），成功失败都算取过；
   * 还一次都没取过时是 null。用来分清「还在取」和「取过了没拿到」。
   */
  settled: string | null;
  /** 手动刷新（任何时候都可用，不受交易时段限制） */
  refresh: () => void;
}

export function useLiveQuotes(codes: string[], enabled: boolean): LiveQuotesState {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);

  // 用 ref 存最新的 codes，让轮询循环不必因为 codes 变化而重建
  const codesRef = useRef(codes);
  codesRef.current = codes;

  const failuresRef = useRef(0);
  const inFlightRef = useRef(false);
  const staleRef = useRef(false);          // 请求飞行途中自选变过 / 有请求被跳过
  const fetchRef = useRef<(() => Promise<boolean>) | null>(null);

  const fetchOnce = useCallback(async (onlyCodes?: string[]): Promise<boolean> => {
    const cs = onlyCodes ?? codesRef.current;
    if (!cs.length) {
      if (!onlyCodes) { setQuotes({}); setSettled(""); }
      return true;
    }
    if (inFlightRef.current) {
      // 上一次还没回来，跳过这一拍；但要记下来，等它回来后补拉一次。
      // 否则「首次请求在飞 → 用户此时粘贴新代码」会让新代码的行情永远缺失
      // （默认不开轮询时没有下一拍来兜底，只能手动刷新）。
      staleRef.current = true;
      return true;
    }
    inFlightRef.current = true;
    const requested = cs.join(",");
    setLoading(true);
    try {
      const data = await api.quote(requested, true);
      // 自动轮询只拉开盘市场，必须与休市市场已有快照合并（这一轮问了却没返回的不留旧价）；首次 / 手动刷新才整体替换。
      setQuotes((prev) => mergePolledQuotes(prev, data, onlyCodes));
      setError(null);
      failuresRef.current = 0;
      return true;
    } catch {
      failuresRef.current += 1;
      // 旧价不留着当现价：手动 / 首次取数失败马上撤价提示，自动轮询连续失败才撤（见 quoteFailure）
      const failed = quoteFailure(failuresRef.current, onlyCodes);
      if (failed) { setQuotes(failed.drop); setError(failed.error); }
      return false;
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      if (!onlyCodes) setSettled(requested);
      // 这一趟拉的是不是已经过期的名单？过期就立刻补一次（只补一次，不会滚雪球：
      // 补拉时 staleRef 已复位，只有再次发生变动才会再补）。
      const changed = !onlyCodes && codesRef.current.join(",") !== requested;
      if (staleRef.current || changed) {
        staleRef.current = false;
        void fetchRef.current?.();
      }
    }
  }, []);
  fetchRef.current = fetchOnce;

  const refresh = useCallback(() => {
    void fetchOnce();
  }, [fetchOnce]);

  // 首次进入 / 自选变化：立即拉一次（与开关无关，页面总要有数据）
  useEffect(() => {
    void fetchOnce();
  }, [codes, fetchOnce]);

  // 轮询循环
  useEffect(() => {
    // 循环本身(锁、定时器、停掉后不复活)在 startPollLoop 里;每次 effect 起一条、cleanup 停掉,
    // StrictMode 的 mount→unmount→mount 也不会留下第二条。
    if (!enabled) {
      setPolling(false);
      return;
    }
    const poll = startPollLoop({
      // 没在跑也要保持一个心跳，好在开盘 / 页面切回来时自动恢复
      shouldRun: () => !document.hidden && isTradingHours(codesRef.current) && codesRef.current.length > 0,
      tick: async () => {
        const ok = await fetchOnce(tradingMarketSymbols(codesRef.current));
        return ok ? LIVE_INTERVAL_MS : Math.min(LIVE_INTERVAL_MS * 2 ** failuresRef.current, MAX_BACKOFF_MS);
      },
      idleMs: 10_000,
      onState: setPolling,
    });

    // 页面切回来时立刻重新评估，不用等下一拍（一拍还在取时什么都不做，见 startPollLoop）
    const onVisible = () => {
      if (!document.hidden) poll.kick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      poll.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, fetchOnce]);

  return { quotes, loading, updatedAt: quoteSnapshotTime(quotes), polling, error, settled, refresh };
}
