/**
 * 证据查看器 + 报告附录(Phase 1 M2):运行末尾由编排器生成 `RUN/viewer.html`(自包含,无外链)与 `RUN/report_appendix.md`。
 * 只读取已合并的产物(evidence / calcs / conflicts / stages / ledger / report),不改任何受保护文件;给非程序员"一眼能看"的产物。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { gateRegexps, gateStagePatterns, type RunConfig } from "./config.ts";
import { complianceGate } from "./gate.ts";
import { atomicWrite } from "./fsutil.ts";
import type { Manifest } from "./merge.ts";
import type { RunView } from "./validator.ts";


export const VIEWER_REL = "viewer.html";
export const APPENDIX_REL = "report_appendix.md";

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function cell(s: unknown, max = 80): string {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface ViewerData {
  run: { run_id: string; symbol: string; market: string; status: string; started_at: string; finished_at: string | null; endpoint_scope?: string; registry_version?: string | null; evidence_count: number; calculation_count: number };
  ledger: { script: string; status: string; exit_code: number | null; duration_ms: number; raw_files: number; injected?: string }[];
  evidence: Record<string, unknown>[];
  calcs: Record<string, unknown>[];
  conflicts: unknown[];
  stages: { stage: string; status: string; summary: string; gaps: unknown[]; evidence_ids: number; calculation_ids: number; record: Record<string, unknown> | null }[];
  report: string | null;
  final_errors: string[];
}

export function collectViewerData(cfg: Pick<RunConfig, "runId" | "symbol" | "market">, run: RunView, manifest: Manifest): ViewerData {
  const ledger = Object.values(run.ledger).map((l) => ({ script: l.script, status: l.status, exit_code: l.exit_code, duration_ms: l.duration_ms, raw_files: Object.keys(l.raw_files ?? {}).length, ...(l.injected ? { injected: l.injected } : {}) }));
  const evidence = [...run.evidence.values()].map((e) => ({ ...e }));
  const calcs = run.calcs.filter((c) => c.record).map((c) => ({ file: path.basename(c.file), ...c.record! }));
  const stages = manifest.stages.map((s) => {
    const so = run.stage(s.stage);
    return { stage: s.stage, status: s.status, summary: String(so?.summary ?? ""), gaps: so?.gaps ?? [], evidence_ids: so?.evidence_ids?.length ?? 0, calculation_ids: so?.calculation_ids?.length ?? 0, record: (so as Record<string, unknown> | null) };
  });
  return {
    run: { run_id: cfg.runId, symbol: cfg.symbol, market: cfg.market, status: manifest.status, started_at: manifest.started_at, finished_at: manifest.finished_at, endpoint_scope: manifest.endpoint_scope, registry_version: manifest.registry_version,
      evidence_count: manifest.evidence_count, calculation_count: manifest.calculation_count },
    ledger, evidence, calcs, conflicts: run.conflicts, stages, report: run.report, final_errors: manifest.final_errors ?? [],
  };
}

export function renderAppendix(d: ViewerData): string {
  const L: string[] = [];
  L.push(`# 报告附录 · ${d.run.symbol}(${d.run.market})· 运行 ${d.run.run_id} · 状态 ${d.run.status}`, "");
  L.push("> 本附录由编排器从已校验产物自动生成:每条证据 / 计算都可回溯到 raw 原始响应与计算 DAG;生成后已过合规复验(命中行整行删除)。", "");
  L.push(`- 证据 ${d.run.evidence_count} 条 · 计算 ${d.run.calculation_count} 条 · 取数端点 ${d.ledger.length} 个 · 数据源冲突 ${d.conflicts.length} 条 · 端点范围 ${d.run.endpoint_scope ?? "?"}(注册表 ${d.run.registry_version ?? "?"})`, "");
  L.push("## A. 取数账本", "", "| 端点 | 状态 | 退出码 | 耗时 ms | raw 文件 | 注入 |", "|---|---|---|---|---|---|");
  for (const l of d.ledger) L.push(`| ${l.script} | ${l.status} | ${l.exit_code ?? "-"} | ${l.duration_ms} | ${l.raw_files} | ${l.injected ?? ""} |`);
  L.push("", "## B. 阶段产物", "", "| 阶段 | 状态 | 引用证据 | 引用计算 | 缺口 | 摘要 |", "|---|---|---|---|---|---|");
  for (const s of d.stages) L.push(`| ${s.stage} | ${s.status} | ${s.evidence_ids} | ${s.calculation_ids} | ${s.gaps.length} | ${cell(s.summary, 160)} |`);
  L.push("", "## C. 计算 DAG(calc id → 函数 → 输出 → 输入引用)", "", "| calc id | 函数 | 输出 | 单位 | 状态 | 输入引用 |", "|---|---|---|---|---|---|");
  for (const c of d.calcs) {
    const out = (c.output ?? {}) as Record<string, unknown>;
    const refs = ((c.inputs_refs ?? []) as { ref_type: string; ref_id: string }[]).map((r) => r.ref_id).join(" ");
    L.push(`| ${c.calculation_id} | ${c.function} | ${cell(out.value, 40)} | ${cell(out.unit, 20)} | ${cell(out.status, 20)} | ${cell(refs, 200)} |`);
  }
  L.push("", "## D. 数据源冲突(权威冲突集)", "");
  if (!d.conflicts.length) L.push("(无)");
  for (const c of d.conflicts as { field: string; period: string; unit: string; values: { id: string; source: string; value: unknown }[] }[]) L.push(`- ${c.field} @ ${c.period}(${c.unit}):${c.values.map((v) => `${v.source}=${cell(v.value, 30)}(${v.id})`).join(" vs ")}`);
  L.push("", "## E. 数据缺口", "");
  let anyGap = false;
  for (const s of d.stages) for (const g of s.gaps as { operation: string; reason_code: string; detail: string }[]) { anyGap = true; L.push(`- [${s.stage}] ${g.operation}:${g.reason_code} — ${cell(g.detail, 200)}`); }
  if (!anyGap) L.push("(无)");
  if (d.final_errors.length) { L.push("", "## F. 最终校验错误", ""); for (const e of d.final_errors) L.push(`- ${cell(e, 300)}`); }
  // 链接列:市场声音 / 新闻类证据的原文链接写在 note 的 link=…(报告正文不贴 URL,靠这里"点回原帖")
  L.push("", "## G. 证据索引(按端点 / 字段排序)", "", "| id | 端点脚本 | 字段 | 值 | 单位 | 币种 | 期间 | 来源 | 链接 | raw |", "|---|---|---|---|---|---|---|---|---|---|");
  const evs = [...d.evidence].sort((a, b) => String(a.endpoint).localeCompare(String(b.endpoint)) || String(a.field).localeCompare(String(b.field)) || String(a.period).localeCompare(String(b.period)));
  for (const e of evs) L.push(`| ${e.id} | ${cell(e.endpoint, 40)} | ${cell(e.field, 40)} | ${cell(e.value, 60)} | ${cell(e.unit, 12)} | ${cell(e.currency, 6)} | ${cell(e.period, 24)} | ${cell(e.source, 20)} | ${linkOf((e as { note?: unknown }).note)} | ${cell(e.raw_ref, 70)} |`);
  return L.join("\n") + "\n";
}

/** note 里的 link=<url>(mapper 约定;到下一个分号为止)→ markdown 链接;没有则空 */
export function linkOf(note: unknown): string {
  const m = /(?:^|;)\s*link=(https?:\/\/[^;\s|]+)/.exec(String(note ?? ""));
  if (!m) return "";
  // Markdown 元字符再编码一次:URL 里的 ) ! [ ] < > 否则能从 [原文](…) 里"逃出来"拼出第二个链接 / 远程图片(Codex 审查 voice-r2)
  const url = m[1].replace(/[()<>\[\]!'"`]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  return `[原文](<${url}>)`;
}

const CSS = `body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f6f7f9;color:#1f2328}header{background:#1f2d3d;color:#fff;padding:14px 20px}header h1{margin:0;font-size:18px}header .meta{opacity:.85;font-size:13px;margin-top:4px}nav{display:flex;gap:6px;padding:10px 20px;background:#fff;border-bottom:1px solid #ddd;position:sticky;top:0}nav button{border:1px solid #cbd5e1;background:#fff;padding:6px 12px;border-radius:6px;cursor:pointer}nav button.on{background:#1f2d3d;color:#fff;border-color:#1f2d3d}main{padding:16px 20px}section{display:none}section.on{display:block}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left;vertical-align:top;word-break:break-all}th{background:#eef2f7;position:sticky;top:46px}input.f{width:100%;max-width:520px;padding:7px 10px;margin:8px 0;border:1px solid #cbd5e1;border-radius:6px}pre{background:#fff;border:1px solid #e2e8f0;padding:12px;white-space:pre-wrap;font-size:13px}.tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:12px;background:#e2e8f0}.ok{background:#d1fae5}.failed{background:#fee2e2}.partial{background:#fef3c7}.muted{color:#64748b;font-size:12px}`;

const JS = `const D=JSON.parse(document.getElementById('data').textContent);const $=s=>document.querySelector(s);
function show(id){document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===id));document.querySelectorAll('section').forEach(s=>s.classList.toggle('on',s.id===id));}
function tbl(rows,cols){if(!rows.length)return '<p class="muted">(无)</p>';return '<table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(r[c])+'</td>').join('')+'</tr>').join('')+'</tbody></table>';}
function esc(v){if(v==null)return '';if(typeof v==='object')v=JSON.stringify(v);return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderEv(){const q=($('#q').value||'').toLowerCase();const rows=D.evidence.filter(e=>!q||JSON.stringify(e).toLowerCase().includes(q));$('#evcount').textContent=rows.length+' / '+D.evidence.length;$('#evtbl').innerHTML=tbl(rows.slice(0,2000),['id','endpoint','field','value','unit','currency','period','as_of','source','record_key','raw_ref','note']);}
function renderCalc(){const rows=D.calcs.map(c=>({calculation_id:c.calculation_id,function:c.function,value:(c.output||{}).value,unit:(c.output||{}).unit,status:(c.output||{}).status,reason:(c.output||{}).reason,inputs_refs:(c.inputs_refs||[]).map(r=>r.ref_id).join(' '),file:c.file}));$('#calctbl').innerHTML=tbl(rows,['calculation_id','function','value','unit','status','reason','inputs_refs','file']);}
function renderStages(){$('#stagetbl').innerHTML=tbl(D.stages.map(s=>({stage:s.stage,status:s.status,summary:s.summary,gaps:s.gaps.length,evidence_ids:s.evidence_ids,calculation_ids:s.calculation_ids})),['stage','status','summary','gaps','evidence_ids','calculation_ids']);$('#stagejson').textContent=JSON.stringify(D.stages.map(s=>s.record),null,1);}
function renderConf(){$('#conftbl').innerHTML=tbl(D.conflicts.map(c=>({field:c.field,period:c.period,unit:c.unit,values:c.values.map(v=>v.source+'='+v.value+' ('+v.id+')').join(' | ')})),['field','period','unit','values']);}
function renderLedger(){$('#ledtbl').innerHTML=tbl(D.ledger,['script','status','exit_code','duration_ms','raw_files','injected']);}
document.addEventListener('DOMContentLoaded',()=>{renderEv();renderCalc();renderStages();renderConf();renderLedger();$('#reporttext').textContent=D.report||'(无 report.md)';$('#q').addEventListener('input',renderEv);document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>show(b.dataset.t)));show('overview');});`;

// Hash only our compiled renderer, never scripts read from a run artifact.
// No allow-same-origin: the renderer cannot access API credentials.
export const VIEWER_CSP = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(JS).digest("base64")}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;

export function renderHtml(d: ViewerData): string {
  // JSON 数据块:把所有 "<" 转成 \u003c(JSON 合法转义),任何 HTML / </script 载荷都不会被解析器当成标签
  const json = JSON.stringify(d).replace(/</g, "\\u003c");
  const st = (s: string) => `<span class="tag ${s}">${esc(s)}</span>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>研究产物查看器 · ${esc(d.run.symbol)} · ${esc(d.run.run_id)}</title><style>${CSS}</style></head><body>
<header><h1>${esc(d.run.symbol)}(${esc(d.run.market)})研究产物查看器 · 运行 ${esc(d.run.run_id)} · 状态 ${st(d.run.status)}</h1>
<div class="meta">开始 ${esc(d.run.started_at)} · 结束 ${esc(d.run.finished_at)} · 证据 ${d.run.evidence_count} · 计算 ${d.run.calculation_count} · 冲突 ${d.conflicts.length} · 端点范围 ${esc(d.run.endpoint_scope ?? "?")} · 注册表 ${esc(d.run.registry_version ?? "?")} · 自包含页面,离线可开</div></header>
<nav><button data-t="overview">总览</button><button data-t="report">报告</button><button data-t="evidence">证据</button><button data-t="calcs">计算 DAG</button><button data-t="conflicts">冲突</button><button data-t="stages">阶段产物</button><button data-t="ledger">取数账本</button></nav>
<main>
<section id="overview"><h2>总览</h2><p>本页只展示编排器已校验的产物;每条证据可回溯 raw 原始响应,每个计算列出输入引用(DAG)。生成后已过合规复验(命中行整行删除)。</p>
<h3>阶段</h3><div id="stagetbl_ov">${d.stages.map((s) => `<div>${esc(s.stage)} ${st(s.status)} <span class="muted">引用证据 ${s.evidence_ids} · 计算 ${s.calculation_ids} · 缺口 ${s.gaps.length}</span></div>`).join("")}</div>
${d.final_errors.length ? `<h3>最终校验错误</h3><pre>${esc(d.final_errors.join("\n"))}</pre>` : ""}</section>
<section id="report"><h2>report.md</h2><pre id="reporttext"></pre></section>
<section id="evidence"><h2>证据 <span class="muted" id="evcount"></span></h2><input class="f" id="q" placeholder="筛选:字段 / 来源 / 端点 / 值 / 期间(任意文本)"><div id="evtbl"></div></section>
<section id="calcs"><h2>计算 DAG</h2><div id="calctbl"></div></section>
<section id="conflicts"><h2>数据源冲突</h2><div id="conftbl"></div></section>
<section id="stages"><h2>阶段产物</h2><div id="stagetbl"></div><h3>原始 JSON</h3><pre id="stagejson"></pre></section>
<section id="ledger"><h2>取数账本</h2><div id="ledtbl"></div></section>
</main>
<script id="data" type="application/json">${json}</script>
<script>${JS}</script></body></html>`;
}

/**
 * 合规复验:**在数据层逐个字符串替换**,而不是删掉渲染后的整行。
 *
 * 🔴 全审 r3-P1-3 说的是"附录与查看器在最终 gate 之后生成、却从不复检",而且它们自己写着
 *    「不含任何判断与建议」—— 声称与代码不符。
 * 🔴 但**第一版修法(整行删除)把查看器弄坏了**(修复复审 r1-P2-4):HTML 把整个 ViewerData
 *    `JSON.stringify` 成**一行** `<script id="data">`,里面任意一条证据命中就会把整个数据块删掉,
 *    页面 `getElementById("data")` 拿到 null 直接报废。
 *    ⇒ 结构化产物不能按行删。改成在**数据进入渲染之前**逐个字符串脱敏:命中的字符串整条替换成
 *    占位符,结构完全不动。附录与 HTML 因此共用同一份已净化的数据。
 */
const REDACTED_NOTE = "〔已按产出红线移除〕";

/**
 * 净化 ViewerData:命中产出红线的**自由文本**替换成占位符,结构与身份信息一律不动。
 *
 * 🔴 第一版按行删除,把整个 `<script id="data">` 数据块删没了(修复复审 r1-P2-4)。
 * 🔴 第二版逐字符串替换又踩两个坑(修复复审 r2):
 *    ① **对象键没查** —— 键本身就是一句越界建议时(如 `{"<动作建议>": "30%"}`)原样外传(calc 的 inputs / output.details 是自由形状);
 *    ② **结构性字符串被误替** —— `run_id: "BUY"`、`raw_ref: "raw/BUY"`、`function: "stop-loss"`
 *       会命中英文规则,整串变占位符,**证据就追不回去了**。
 * ⇒ 沿用 `proseStrings` 那套"取值受不受控"的判断:受控字段(id / 路径 / 函数名 / 枚举 / 数值型)跳过,
 *   只净化自由文本。这是同一条纪律的第二次应用 —— 判断标准是**字段取值受不受控**,不是名字长什么样。
 */
/**
 * **格式 / 枚举严格受控**的字段:取值形态由 schema 钉死(id 模式、枚举、日期、哈希、路径),
 * 净化它们只会破坏溯源,而它们本身装不下一句建议。
 * ⚠️ 只放行**真正受控**的 —— `source` / `endpoint` / `field` / `unit` / `record_key` 这些
 * schema 上只要求"非空字符串",曾被误列在这里,`source: "<一句越界建议>"` 就能原样外传
 * (修复复审 r3-P2)。判断标准始终是**取值受不受控**,不是"名字像不像标识符"。
 */
const STRUCTURAL_KEYS = new Set([
  "id", "run_id", "calculation_id", "raw_ref", "function", "symbol", "market", "period",
  "adjustment", "stage", "status", "reason_code", "ref_id", "ref_type",
  "fetched_at", "as_of", "started_at", "finished_at", "sha256",
]);

/**
 * 🔴 **键名不等于位置**:`status` 在 schema 固定位置是枚举,但 calc 的 `inputs` / `output.details`
 * 是**自由形状** —— 嵌套对象里同样叫 `status` 的字段能装任意文本,只按键名放行就等于开了后门
 * (`{"extra_findings":[{"status":"<一句建议>"}]}`,复审 r4-P2)。
 * viewer 拿不到 schema 路径,所以再加一道**取值形状**闸:身份 / 枚举 / 日期 / 哈希 / 相对路径
 * 都是"无空白的紧凑串",一句话不可能长这样。两个条件都满足才跳过净化。
 * ⚠️ 形状放宽了就等于把后门开回来 —— 这里刻意**不允许空白**。
 */
const CONTROLLED_SHAPE = /^[\w.:@/+-]+$/u;

export function scrubStrings<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const hit = (t: string) => !complianceGate(t, gateStagePatterns(), [], gateRegexps()).ok;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      // 身份 / 路径 / 枚举:不碰,否则回溯链就断了 —— 但**键名与取值形状都得对上**(见 CONTROLLED_SHAPE)
      if (STRUCTURAL_KEYS.has(key) && CONTROLLED_SHAPE.test(v)) return v;
      if (hit(v)) { removed += 1; return REDACTED_NOTE; }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      const taken = new Set(entries.map(([k]) => k));   // 占位键还要避开**原有键**,否则会覆盖别人的数据
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, x] of entries) {
        let safeKey = k;
        if (hit(k)) {
          removed += 1;
          do { safeKey = `〔已移除键-${++n}〕`; } while (taken.has(safeKey));
          taken.add(safeKey);
        }
        out[safeKey] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, "") as T, removed };
}

export function writeViewer(cfg: Pick<RunConfig, "runDir" | "runId" | "symbol" | "market">, run: RunView, manifest: Manifest): { htmlPath: string; appendixPath: string; gateRemoved: number } {
  const raw = collectViewerData(cfg, run, manifest);
  const { value: data, removed } = scrubStrings(raw);
  const htmlPath = path.join(cfg.runDir, VIEWER_REL);
  const appendixPath = path.join(cfg.runDir, APPENDIX_REL);
  atomicWrite(htmlPath, renderHtml(data));
  atomicWrite(appendixPath, renderAppendix(data));
  return { htmlPath, appendixPath, gateRemoved: removed };
}

export function viewerExists(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, VIEWER_REL));
}

/** 测试入口:直接验净化行为(走 writeViewer 的话数据是重算的,注入不进去) */
export const scrubForTest = scrubStrings;
