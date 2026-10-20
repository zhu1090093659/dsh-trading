/**
 * **收工守卫**(Core,所有大脑共用)。语义 = "缺产物 / 阶段校验不过,不许正常收工":
 * 大脑想结束本轮时,产品先查一次 ——
 *   - 合格 → 放行;
 *   - 不合格 → 拦下,把问题清单交回大脑接着修(API 大脑在同一段对话里继续;本机 Agent 起一个续跑会话);
 *   - 连续 maxIdle 次拦截之间都**没有新增合法计算记录**(空转),或本轮累计拦截达 maxTotal 次(兜底硬上限,
 *     不论有没有推进)→ 终止本轮:编排器把这轮判为失败并带着校验错误补跑(不会被当成正常完成)。
 *
 * v1 里这是旧引擎的 Stop 钩子(独立子进程 + 日志文件);v2 由产品在进程内直接执行,判据逐条保留,
 * 包括 #46 的**推进感知**:合规工作流是"攒好几轮 calc → 最后一步才写 stage 文件",
 * 只数拦截次数会在模型还在攒 calc 时就把预算烧光(2026-09-05 真实运行实测)。
 * ⇒ 两次拦截之间**合法计算记录的集合变了且条数没减少**才算推进;一旦推进,空转计数回 1。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Stage } from "./config.ts";
import { currentPlugin } from "./plugin.ts";
import { loadRun, validateStage } from "./validator.ts";

/** 连续无推进的拦截上限(API 大脑:同一段对话里多一轮,代价小) */
export const MAX_STOP_BLOCKS = 6;
/** 一个 (阶段, attempt) 内累计拦截的硬上限,不论有没有推进 */
export const MAX_TOTAL_STOP_BLOCKS = 20;
/**
 * 本机 Agent 的上限更紧:每次"拦下"都要重新拉起一个 CLI 会话(冷启动 + 重读产物),代价是 API 大脑的几十倍。
 * maxIdle=1 ⇒ 只要上一次续跑有新计算落盘就接着续;一次空转就交给编排器带着校验错误补跑。
 */
export const LOCAL_AGENT_STOP_LIMITS = { maxIdle: 1, maxTotal: 3 } as const;

/** 阶段想收工时还差什么;空数组 = 可以收工 */
export function stageProblems(runDir: string, stage: Stage): string[] {
  const problems: string[] = [];
  const expected = [path.join(runDir, "stages", `${stage}.json`)];
  // 报告阶段的名字由插件给,Core 不写死
  if (stage === currentPlugin().reportStage) expected.unshift(path.join(runDir, "report.md"));
  for (const f of expected) if (!fs.existsSync(f)) problems.push(`缺产物:${path.relative(runDir, f).split(path.sep).join("/")}`);
  if (problems.length) return problems;
  // 账本用磁盘审计副本;最终裁判仍是编排器内存账本(那几条不是大脑改得了的,不拿来拦它)
  const r = validateStage(stage, loadRun(runDir));
  return r.errors.filter((e) => !/账本|编排器取数记录/.test(e)).slice(0, 8);
}

/**
 * 统计 calcs/ 下**合法计算记录**:条数 + 整套 calculation_id(排序后)的指纹。
 * 合法 = JSON 可解析且 calculation_id 为非空 string。
 * 🔴 这比 merge.ts 的 loadCalcs **严得多**,别照它对齐:loadCalcs 只要 JSON 能解析就收一条。
 *    按那个口径判推进,"用无意义写盘刷掉预算"就挡不住了 —— 写个参数文件就算一次推进。
 * 指纹只用于"和上一次拦截比有没有变",不进产物、不参与任何安全判定,sha1 足够。
 */
export function validCalcs(runDir: string): { count: number; fp: string } {
  const dir = path.join(runDir, "calcs");
  const ids: string[] = [];
  // 目录不存在与目录空着要给出同一个指纹:否则"刚建好空 calcs/"会被当成一次推进
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    // 点开头的文件一律不算:合法计算文件名由受控工具限成 NN_name.json,产物侧读 calcs/ 也跳过点文件
    if (f.startsWith(".") || !f.endsWith(".json")) continue;
    let rec: unknown;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (rec && typeof rec === "object" && typeof (rec as { calculation_id?: unknown }).calculation_id === "string"
      && (rec as { calculation_id: string }).calculation_id.length > 0) ids.push((rec as { calculation_id: string }).calculation_id);
  }
  ids.sort();
  return { count: ids.length, fp: crypto.createHash("sha1").update(ids.join("\n")).digest("hex").slice(0, 16) };
}

export type StopDecision =
  | { decision: "allow" }
  /** 检查本身出错:放行但出声(编排器的 validator 兜底),绝不让守卫故障卡死大脑 */
  | { decision: "error"; error: string }
  | { decision: "block"; message: string; problems: string[]; idleStreak: number; blocks: number }
  | { decision: "terminate"; reason: string; problems: string[]; idleStreak: number; blocks: number };

/** 一个 (阶段, attempt) 用一个实例 */
export class StopGuard {
  private readonly runDir: string;
  private readonly stage: Stage;
  private readonly maxIdle: number;
  private readonly maxTotal: number;
  private lastFp: string | undefined;
  private lastCount: number | undefined;
  private streak = 0;
  /** 本轮已拦截次数 */
  blocks = 0;
  /** 本轮是否已被终止 */
  terminated = false;

  constructor(runDir: string, stage: Stage, limits: { maxIdle: number; maxTotal: number } = { maxIdle: MAX_STOP_BLOCKS, maxTotal: MAX_TOTAL_STOP_BLOCKS }) {
    this.runDir = runDir;
    this.stage = stage;
    this.maxIdle = limits.maxIdle;
    this.maxTotal = limits.maxTotal;
  }

  /** 大脑想收工时调用一次 */
  check(): StopDecision {
    let problems: string[];
    try { problems = stageProblems(this.runDir, this.stage); }
    catch (e) { return { decision: "error", error: e instanceof Error ? e.message : String(e) }; }
    if (!problems.length) return { decision: "allow" };
    const cur = validCalcs(this.runDir);
    const progressed = this.lastFp === undefined || this.lastCount === undefined
      ? true
      : cur.fp !== this.lastFp && cur.count >= this.lastCount;
    const idleStreak = progressed ? 1 : this.streak + 1;
    if (idleStreak <= this.maxIdle && this.blocks < this.maxTotal) {
      this.blocks += 1;
      this.streak = idleStreak;
      this.lastFp = cur.fp;
      this.lastCount = cur.count;
      const message = (`【收工检查】本阶段(${this.stage})还不能收工(无推进空转 ${idleStreak}/${this.maxIdle},本轮累计拦截 ${this.blocks}/${this.maxTotal}),` +
        `请先修好再结束本轮;有新增计算落盘则空转计数回 1,但累计上限照涨:\n- ${problems.join("\n- ")}`).slice(0, 1800);
      return { decision: "block", message, problems, idleStreak, blocks: this.blocks };
    }
    this.terminated = true;
    // 两种终止要分得开:一直在算却写不出产物(累计上限)≠ 拦下后什么都没做(空转)。混成一句,编排器补跑时就不知道该怪谁
    const why = this.blocks >= this.maxTotal
      ? `本轮累计拦截已达上限 ${this.blocks}/${this.maxTotal} 次${progressed ? "(上一次拦截后仍有新计算落盘)" : ""}`
      : `${this.streak > 1 ? `连续 ${this.streak} 次拦截后都没有新增计算` : "上一次拦截后没有新增计算"}(本轮累计拦截 ${this.blocks} 次)`;
    const reason = `收工检查终止本轮:${why},仍不合格:${problems.slice(0, 3).join("; ")}`.slice(0, 1000);
    // idleStreak = **已经发生过的**连续空转拦截数,不是本次判定值(本次判定值 = 它 + 1)
    return { decision: "terminate", reason, problems: problems.slice(0, 8), idleStreak: this.streak, blocks: this.blocks };
  }
}
