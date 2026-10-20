import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { SortDir, SortState } from "@/lib/tableSort";
import { cn } from "@/lib/utils";

/**
 * 可排序的表头：点一下排序，再点反过来，第三下恢复原来的顺序。
 * 数字列第一下从大到小；文字列（名称、代码）传 firstDir="asc"。
 */
export function SortTh({ label, k, sort, onSort, firstDir = "desc", right, className, disabled, disabledTitle = "调整顺序时不按列排序", title }: {
  label: string; k: string; sort: SortState | null; onSort: (key: string, firstDir?: SortDir) => void;
  firstDir?: SortDir; right?: boolean; className?: string; disabled?: boolean; disabledTitle?: string;
  /** 这一列不是按显示的头一行排时写清楚按什么排（如「现价」一列按涨跌幅排） */
  title?: string;
}) {
  const active = sort?.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cn(right && "text-right", className)}>
      <button type="button" onClick={() => onSort(k, firstDir)} disabled={disabled}
        title={disabled ? disabledTitle : `${title ?? `按${label}排序`}（再点一下反过来，第三下恢复）`}
        className={cn("inline-flex items-center gap-0.5 whitespace-nowrap hover:text-foreground disabled:cursor-default disabled:hover:text-inherit",
          right && "flex-row-reverse", active && "text-primary")}>
        {label}
        <Icon aria-hidden className={cn("h-3 w-3 shrink-0", !active && "opacity-30")} />
      </button>
    </th>
  );
}

/** 「调整顺序」开关：打开后不按列排序，每行出现上移 / 下移 */
export function ReorderToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={on}
      title={on ? "排好了，退出调整" : "自己排持仓的先后（只记在这台电脑的浏览器里）"}
      className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
        on ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
      <ArrowUpDown className="h-3 w-3" />{on ? "完成" : "调整顺序"}
    </button>
  );
}

/** 一行的上移 / 下移 */
export function MoveButtons({ name, first, last, onMove }: { name: string; first: boolean; last: boolean; onMove: (delta: -1 | 1) => void }) {
  const btn = "rounded border border-border p-0.5 text-muted-foreground hover:border-primary/50 hover:text-primary disabled:opacity-25 disabled:hover:border-border disabled:hover:text-muted-foreground";
  return (
    <span className="inline-flex shrink-0 gap-0.5">
      <button type="button" onClick={(e) => { e.stopPropagation(); onMove(-1); }} disabled={first} aria-label={`${name} 上移`} title="上移" className={btn}><ArrowUp className="h-3 w-3" /></button>
      <button type="button" onClick={(e) => { e.stopPropagation(); onMove(1); }} disabled={last} aria-label={`${name} 下移`} title="下移" className={btn}><ArrowDown className="h-3 w-3" /></button>
    </span>
  );
}

/** 隐私模式下被遮住的金额列不给排序：金额是 ••••，行的先后却能看出哪只仓位最重、亏得最多 */
export const PRIVATE_SORT_TITLE = "隐私模式下不按这一列排序（排出来的先后会透露金额大小）";
