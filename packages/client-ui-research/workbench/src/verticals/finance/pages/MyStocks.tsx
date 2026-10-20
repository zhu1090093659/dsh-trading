import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Star, Wallet } from "lucide-react";
import { PageTabs } from "@/components/ui/PageTabs";
import { storageGet, storageSet } from "@/lib/storage";
import { Watchlist } from "./Watchlist";
import { Portfolio } from "./Portfolio";

type Tab = "watch" | "hold";
const TAB_KEY = "vr-my-stocks-tab";
const isTab = (v: string | null): v is Tab => v === "watch" || v === "hold";

/** 自选与持仓：两张表放在一页里切换。地址里的 `?tab=` 说了算（旧的 /watchlist、/portfolio 跳过来会带上），没有就回到上次看的那页。 */
export function MyStocks() {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("tab");
  const remembered = storageGet(TAB_KEY);
  const tab: Tab = isTab(fromUrl) ? fromUrl : isTab(remembered) ? remembered : "watch";
  useEffect(() => { storageSet(TAB_KEY, tab); }, [tab]);
  const pick = (t: Tab) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set("tab", t);
    return next;
  }, { replace: true });

  const tabs = <PageTabs label="自选与持仓" value={tab} onChange={pick}
    options={[{ key: "watch", label: "自选", icon: Star }, { key: "hold", label: "持仓", icon: Wallet }]} />;
  return tab === "watch" ? <Watchlist tabs={tabs} /> : <Portfolio tabs={tabs} />;
}
