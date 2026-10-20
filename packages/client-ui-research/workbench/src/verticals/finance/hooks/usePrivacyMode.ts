import { useSyncExternalStore } from "react";

import { storageGet, storageSet } from "@/lib/storage";

// 隐私模式开关：全站共用一份，顶栏、持仓页、对话框同时跟着变；记在本机浏览器里（换设备 / 清缓存后回到关闭）。
const KEY = "vr-privacy";
let on = storageGet(KEY) === "on";
const listeners = new Set<() => void>();

function setPrivacyMode(next: boolean) {
  on = next;
  storageSet(KEY, next ? "on" : "off");
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function usePrivacyMode() {
  const value = useSyncExternalStore(subscribe, () => on, () => false);
  return { on: value, toggle: () => setPrivacyMode(!on) };
}
