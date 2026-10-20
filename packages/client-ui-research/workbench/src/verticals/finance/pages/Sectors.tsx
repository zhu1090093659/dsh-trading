import { Link } from "react-router-dom";
import { Flame, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import sectorsData from "@/data/sectors.json";
import { sectorSteps, sectorTabs } from "@/lib/sectorPrompts";

/**
 * 产业研究 —— **列出全部板块，每个板块配分步研究提示词**（2026-10-09 Simon 定）。
 *
 * 🔴 板块里的内容不由我们填：填了就等于在给投资结论。我们给方法（先读研报、再按栏目逐页梳理），
 *    用户把提示词发给自己的 AI，结论由它当场查资料得出。
 *    以前只列已核实环节的两个板块，其余藏起来 —— 现在每个板块都有可执行的提示词，不再是空承诺。
 * ⚠️ `verified` 仍然有用：已核实的环节会显示在板块页，并写进第 1 步提示词让 AI 覆盖到。
 */
export function Sectors() {
  const sectors = sectorsData.sectors;
  const hotCount = sectors.filter((s) => s.hot).length;

  useAiPage({
    key: "sectors",
    title: "产业研究",
    context:
      `产业研究 · ${sectors.length} 个板块（其中标热门 ${hotCount} 个）。每个板块配好让 AI 一步步梳理的提示词，内容不预先填写、不含标的：\n` +
      sectors.map((s) => `- ${s.label}：${s.tagline}｜栏目：${sectorTabs(s).join("、")}${s.verified ? `｜已核实环节 ${s.nodes.length} 个` : ""}`).join("\n"),
    suggestions: ["这些板块之间有哪些上下游关系", "新手研究一个产业该从哪里入手", "帮我挑一个板块，说说第 1 步该读哪些资料"],
  });

  return (
    <div>
      <PageHeader
        title="产业研究"
        subtitle={`${sectors.length} 个板块 · 每个都配好分步提示词：先读研报，再按栏目一页页梳理，由你的 AI 查资料完成`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sectors.map((s) => (
          <Link key={s.key} to={`/sectors/${s.key}`}>
            <GlassCard glow={s.hot} className="flex h-full flex-col justify-between">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <h3 className="text-base font-bold">{s.label}</h3>
                  {s.hot && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      <Flame className="h-3 w-3" /> 热门
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{s.tagline}</p>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3 text-xs">
                <span className="text-muted-foreground">
                  {s.verified ? `${s.nodes.length} 个环节 · ` : ""}{sectorSteps(s).length} 步研究提示词
                </span>
                <ChevronRight className="h-4 w-4 text-primary" />
              </div>
            </GlassCard>
          </Link>
        ))}
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground/60">
        共 {sectors.length} 个板块，其中 {hotCount} 个热门 · 这里只给研究方法，内容由你的 AI 查资料产出，每个数字都要写明来源
      </p>
      <Disclaimer />
    </div>
  );
}
