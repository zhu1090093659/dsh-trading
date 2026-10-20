import { workspaceRoot } from "@/lib/workspace";
import { useEffect, useState } from "react";

import { storageGet, storageSet } from "@/lib/storage";

// 恢复公开版暖橙主题，保留既有深浅主题选择。
// 机制：亮色时给 <html> 加 .light（暗色为无类名的默认态）。
export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    const saved = storageGet("vr-theme");
    if (saved) return saved === "dark";
    return document.body.hasAttribute('data-ds-dark-theme') || document.body.dataset.theme === 'dark';
  });

  useEffect(() => {
    workspaceRoot().classList.toggle("light", !dark);
    workspaceRoot().classList.toggle("dark", dark);
    storageSet("vr-theme", dark ? "dark" : "light");
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}
