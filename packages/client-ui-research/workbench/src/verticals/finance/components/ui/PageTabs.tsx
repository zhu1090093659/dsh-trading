import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageTab<T extends string> { key: T; label: string; icon?: LucideIcon; badge?: ReactNode }

/** 页面里的分页切换条（自选 / 持仓、概览 / 深度研究…），样式和资讯雷达的分页一致。 */
export function PageTabs<T extends string>({ value, options, onChange, label, className }: {
  value: T; options: PageTab<T>[]; onChange: (v: T) => void; label: string; className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("mb-4 flex flex-wrap gap-2", className)}>
      {options.map(({ key, label: text, icon: Icon, badge }) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}
          className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors",
            value === key ? "bg-primary/15 font-medium text-primary shadow-glow" : "text-muted-foreground hover:bg-muted/50")}>
          {Icon && <Icon className="h-4 w-4" />}{text}{badge}
        </button>
      ))}
    </div>
  );
}
