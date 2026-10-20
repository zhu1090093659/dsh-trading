import { useCallback, useState } from "react";
import { loadOrder, moveInOrder, saveOrder } from "@/lib/tableSort";
import { storageGet, storageSet } from "@/lib/storage";

/** 持仓自己排的先后：首页和持仓页共用这一份（只记在本机浏览器里） */
export const HOLDINGS_ORDER_KEY = "vr-holdings-order";

/** masked：这份先后是从被遮的列（金额）排序转存来的，隐私模式下不用（见 visibleOrder） */
export function useRowOrder(storageKey: string) {
  const [order, setOrderState] = useState<string[]>(() => loadOrder(storageKey));
  const [masked, setMasked] = useState<boolean>(() => storageGet(`${storageKey}-masked`) === "1");
  const setOrder = useCallback((next: string[], fromMasked = false) => {
    setOrderState(next);
    setMasked(fromMasked);
    saveOrder(storageKey, next);
    storageSet(`${storageKey}-masked`, fromMasked ? "1" : "0");
  }, [storageKey]);
  /** current = 当前显示的先后（全部代码），挪完整份存下来；fromMasked = current 是否还带着金额排出的先后 */
  const move = useCallback((current: readonly string[], code: string, delta: -1 | 1, fromMasked = false) => setOrder(moveInOrder(current, code, delta), fromMasked), [setOrder]);
  return { order, masked, setOrder, move };
}
