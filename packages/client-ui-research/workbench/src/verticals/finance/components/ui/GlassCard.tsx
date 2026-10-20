import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  children: ReactNode;
  className?: string;
  glow?: boolean;
  onClick?: () => void;
}

// 保留公共组件名；视觉是方框面板：面板底色 + 1px 线框 + 8px 圆角（index.css .glass）。
export function GlassCard({ children, className, glow, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "glass p-4",
        glow && "glass-glow",
        onClick && "cursor-pointer transition-colors hover:border-primary/40",
        className,
      )}
    >
      {children}
    </div>
  );
}
