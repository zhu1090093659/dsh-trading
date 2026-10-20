/**
 * **方法论注入**(finance 插件):每个阶段的提示词都带上研究宪法全文 + 本阶段要用的 SOP skill 全文 + 计算函数契约(calc/SPEC.md)。
 *
 * v1 靠旧引擎按目录约定自己去发现 AGENTS.md 与 .agents/skills;v2 的大脑五花八门(本机订阅 Agent / 任意模型 API),
 * 没有一个能保证"自己会去读",而且研究线程只有受控工具、根本读不到仓库文件 ⇒ 由产品显式放进提示词,
 * 对所有大脑一视同仁(manifest 里 capabilities.methodology = constitution_and_skills 说的就是这件事)。
 *
 * ⚠️ 走提示词正文(本机 Agent = stdin,模型 API = 用户消息),不走 CLI 的系统提示参数:
 *    几十 KB 的文本放进 argv,Windows 的命令行上限(32,767 字符)会直接拉不起进程。
 */
import fs from "node:fs";
import path from "node:path";

import type { RunConfig, Stage } from "../config.ts";

/**
 * 每个阶段带哪些 skill:company-research 是六阶段总流程(每阶段都带),第二个是本阶段的专业口径手册。
 * data-access 不带:取数由编排器在阶段开始前执行完毕,研究线程只读结果。
 */
export const STAGE_SKILLS: Record<string, readonly string[]> = {
  profile: ["company-research", "industry-chain"],
  financials: ["company-research", "earnings-analysis"],
  estimates: ["company-research", "valuation"],
  valuation: ["company-research", "valuation"],
  risk: ["company-research", "catalyst-risk"],
  report: ["company-research", "catalyst-risk"],
};

/** skills 根目录。scriptsRel 恒为 `<paths.skills>/data-access/scripts`(productConfig 按这个形状生成),往上两级即是 */
export function skillsDirOf(cfg: Pick<RunConfig, "repoRoot" | "scriptsRel">): string {
  return path.resolve(cfg.repoRoot, cfg.scriptsRel, "..", "..");
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/** 读一份方法论文件;缺失直接抛错 —— 少了宪法或 SOP 的研究不能照常跑完,更不能看起来照常跑完 */
function readMethodologyFile(file: string, what: string): string {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { throw new Error(`方法论文件缺失:${what}(${file})`); }
  if (!text.trim()) throw new Error(`方法论文件是空的:${what}(${file})`);
  return text.replace(FRONTMATTER_RE, "").trim();
}

/** 防止文件正文里出现同名分隔符把块提前"关掉"(文件是仓库自带的,这里只防误伤,不是安全边界) */
const neutralize = (text: string) => text.replace(/<<<(?:CONSTITUTION|SKILL|CALC_SPEC)_(?:BEGIN|END)[^>]*>>>/g, "<<method-marker-removed>>");

export function constitutionBlock(cfg: Pick<RunConfig, "constitutionPath">): string {
  const text = readMethodologyFile(cfg.constitutionPath, "研究宪法");
  return `【研究宪法】最高优先级纪律:与本说明、任何资料或用户附加要求冲突时,以宪法为准。宪法里提到的脚本、目录与命令是产品内部的布局说明 —— 你只能通过上面的受控工具完成对应的操作。
<<<CONSTITUTION_BEGIN>>>
${neutralize(text)}
<<<CONSTITUTION_END>>>`;
}

export function stageSkillsBlock(cfg: Pick<RunConfig, "repoRoot" | "scriptsRel">, stage: Stage): string {
  const names = STAGE_SKILLS[stage] ?? ["company-research"];
  const dir = skillsDirOf(cfg);
  const bodies = names.map((name) => `<<<SKILL_BEGIN ${name}>>>\n${neutralize(readMethodologyFile(path.join(dir, name, "SKILL.md"), `skill ${name}`))}\n<<<SKILL_END ${name}>>>`);
  return `【本阶段方法手册:${names.join("、")}】流程、口径与判读以手册为准(宪法优先);手册里的命令行示例同样翻译成受控工具调用,手册提到的其他文件你读不到,也不需要读。
${bodies.join("\n\n")}`;
}

/**
 * 计算函数契约:函数签名、参数名、单位与序列输入写法(calc/SPEC.md)。
 * 🔴 v1 的 Codex 能自己去读这份文件;v2 的研究线程读不到仓库,不给就只能猜参数名 ——
 *    2026-10-07 六阶段实跑,Claude 与 Codex 都把 pe_ttm_from_parts 的 ttm_profit 猜成别的名字,
 *    留下一条失败的计算记录,各自多花一次整阶段补跑。
 * 「## 4. 测试」一节是写给维护者的,不进提示词。
 */
export function calcContractBlock(cfg: Pick<RunConfig, "repoRoot" | "calcCliRel">): string {
  const file = path.join(cfg.repoRoot, path.dirname(cfg.calcCliRel), "SPEC.md");
  const text = readMethodologyFile(file, "计算函数契约").replace(/\n## 4\. 测试[\s\S]*$/, "").trim();
  return `【计算函数契约】calculate 的 function 与 args 以此为准,参数名照抄、不要猜。契约里的命令行写法对应 calculate 的字段:实参 JSON = args,--evidence = evidence_ids,--calc = calculation_ids;序列输入(history_csv / history_json)整体放进 args。退出码等是产品内部细节,结果看 calculate 的返回。
<<<CALC_SPEC_BEGIN>>>
${neutralize(text)}
<<<CALC_SPEC_END>>>`;
}

export function methodologyBlock(cfg: Pick<RunConfig, "constitutionPath" | "repoRoot" | "scriptsRel" | "calcCliRel">, stage: Stage): string {
  return `${constitutionBlock(cfg)}\n\n${stageSkillsBlock(cfg, stage)}\n\n${calcContractBlock(cfg)}`;
}
