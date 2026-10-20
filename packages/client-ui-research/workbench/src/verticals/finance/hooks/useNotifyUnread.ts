import { useEffect, useState } from "react";

import { backend } from "@/lib/backend";
import { NOTIFY_CHANGED } from "@/lib/notify";

const POLL_MS = 120_000;

/**
 * 侧栏「提醒」的未读数:页面在前台时每 2 分钟查一次,收件箱有变化时立刻刷新。
 * 后端没起来时保持上一次的数,不报错。
 */
export function useNotifyUnread(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const mine = ++seq;
      // 只认最后一次请求的结果,免得慢回来的旧结果把刚标完已读的数盖回去
      backend.notify().then((o) => { if (alive && mine === seq) setUnread(o.inbox.unread); }, () => {});
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    globalThis.addEventListener(NOTIFY_CHANGED, refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      globalThis.removeEventListener(NOTIFY_CHANGED, refresh);
    };
  }, []);
  return unread;
}
