import { workspaceRoot } from "@/lib/workspace";
import { useEffect, useMemo, useState } from "react";

import type { ChartPalette } from "@/lib/backtestView";

/** CSS 里的颜色令牌是 `215 15% 55%` 这种裸 HSL；ECharts 认带逗号的 `hsl()`。 */
function token(style: CSSStyleDeclaration | null, name: string, fallback: string, alpha?: number): string {
  const raw = style?.getPropertyValue(name).trim() ?? "";
  const parts = raw.split(/\s+/);
  if (parts.length !== 3) return fallback;
  return alpha === undefined ? `hsl(${parts.join(", ")})` : `hsla(${parts.join(", ")}, ${alpha})`;
}

export function readPalette(): ChartPalette {
  // 没有页面时（界面测试在 Node 里渲染）一律用下面的兜底色
  const s = typeof document === "undefined" ? null : getComputedStyle(workspaceRoot());
  return {
    text: token(s, "--chart-text", "#78716c"),
    grid: token(s, "--chart-grid", "rgba(120,113,108,.18)"),
    axis: token(s, "--chart-axis", "rgba(120,113,108,.3)"),
    strong: token(s, "--foreground", "#e7e5e4"),
    primary: token(s, "--primary", "#f97316"),
    benchmark: token(s, "--muted-foreground", "#a8a29e"),
    rise: token(s, "--danger", "#ef4444"),
    fall: token(s, "--success", "#22c55e"),
    neutral: token(s, "--muted", "#292524"),
    tooltipBg: token(s, "--card", "rgba(28,25,23,.92)", 0.96),
    tooltipText: token(s, "--foreground", "#e7e5e4"),
  };
}

/** 主题切换只改 <html> 的类名；图表配置要跟着重算，否则换了主题图还是旧颜色。 */
export function usePalette(): ChartPalette {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setVersion((v) => v + 1));
    mo.observe(workspaceRoot(), { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return useMemo(readPalette, [version]);
}
