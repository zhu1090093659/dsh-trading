/** 几个互斥选项的小切换条（图表的周期 / 指标切换用）。 */
export function SegmentedToggle<T extends string>({ value, options, onChange, disabled, label }: {
  value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-border/70 p-0.5 text-xs">
      {options.map((o) => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)} disabled={disabled} aria-pressed={value === o.key}
          className={`rounded-md px-2.5 py-1 disabled:opacity-50 ${value === o.key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
