/**
 * **逐 turn 上下文**(编排器所有,sha256 记入受保护产物)。
 *
 * 每个 turn 开始前由编排器写一份:当前阶段、attempt、运行目录。受控工具(run_tools.ts,两类大脑共用)
 * 靠它判断"现在是哪个阶段"、把写入限制在本阶段允许的产物上;读不到或与运行目录对不上就拒绝写入。
 *
 * ⚠️ 文件名沿用 v1 的 `.vibe/hook-context.json`:validator 的受保护路径清单按这个名字认它,
 *    改名要两边一起改,而改名本身不带来任何好处。
 */
import path from "node:path";

import type { RunConfig, Stage } from "./config.ts";
import { readJsonIfExists, writeJson } from "./fsutil.ts";

export const TURN_CONTEXT_REL = path.join(".vibe", "hook-context.json");

export interface TurnContext {
  stage: Stage; attempt: number; run_id: string; repo_root: string; data_root: string; run_dir: string; python: string; scripts_rel: string;
  forbidden_path_patterns: string[]; allowed_path_prefixes: string[]; written_at: string;
}

export function writeTurnContext(cfg: RunConfig, stage: Stage, attempt: number): string {
  const p = path.join(cfg.runDir, TURN_CONTEXT_REL);
  const ctx: TurnContext = { stage, attempt, run_id: cfg.runId, repo_root: cfg.repoRoot, data_root: cfg.dataRoot, run_dir: cfg.runDir, python: cfg.python, scripts_rel: cfg.scriptsRel,
    forbidden_path_patterns: cfg.forbiddenPathPatterns, allowed_path_prefixes: cfg.allowedPathPrefixes, written_at: new Date().toISOString() };
  writeJson(p, ctx);
  return p;
}

export function readTurnContext(runDir: string): TurnContext | null {
  return readJsonIfExists<TurnContext>(path.join(runDir, TURN_CONTEXT_REL));
}
