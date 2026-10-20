/**
 * calc 结果的"投影"工具 —— 纯函数,不依赖 validator,也与任何垂类领域无关。
 *
 * 🔴 为什么单独成文件:原来它住在 `validator.ts`,而 `number_fidelity.ts` 要用它 →
 * number_fidelity → validator → finance/register → number_fidelity 形成**循环依赖**,
 * 表现为一个极难读的 `ReferenceError: Cannot access 'activeLexicon' before initialization`。
 * 工具下沉到叶子模块是断环的正解(而不是在环上打补丁)。
 */
export interface ResultProjectionItem { path: string; status: unknown; unit: unknown; value: number | null; display: string | null; /** 源对象是否带 display 键(旧记录没有) */ hasDisplay: boolean }

/**
 * output 的"结果投影":顶层 + details 里所有结果形子对象(含 status / value / unit,如四锚 scenarios)的 status / unit / value / display,按路径排序。
 * 复算比对用它整体比较——子结果的 value 被改而 display 保留、或子 display 被改,都能抓到(Codex 审查 r3 / r4)。旧记录(calc < 0.3.2)没有 display 字段时 display 为 null。
 */
export function resultProjection(output: unknown): ResultProjectionItem[] {
  const out: ResultProjectionItem[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 5 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`, depth + 1)); return; }
    const o = v as Record<string, unknown>;
    if ("status" in o && "value" in o && "unit" in o) {
      out.push({ path: p, status: o.status, unit: o.unit, value: typeof o.value === "number" ? o.value : null, display: typeof o.display === "string" ? o.display : null, hasDisplay: "display" in o });
    }
    for (const [k, x] of Object.entries(o)) if (k !== "display") walk(x, p ? `${p}.${k}` : k, depth + 1);
  };
  walk(output, "", 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
