/**
 * 硬测试数据夹具:把一次真实运行的**前几个阶段产物**快照下来复用,让验证一个新层不必每次重跑六阶段。
 *
 * 为什么要有它 —— ht28 实测的阶段耗时:
 *   profile 109s · financials 127s · estimates 111s · valuation 134s = **8.0 分(47%)**
 *   risk 274s · report 261s = 8.9 分
 * 前四个阶段纯粹是"把数据准备好",每次跑出来几乎一模一样,却吃掉将近一半的墙钟时间。
 * ⚠️ 另一条路(降低 reasoning 档位)已实测**无效**:推理 token 只有 185–625,
 *    时间几乎全花在输出 token 生成上(约 35 tok/s),调推理档省不下来。
 *
 * 🔴 三条不能破的东西:
 * 1. **不缩短提示词压力**。夹具原样保留前四阶段产物 —— 章节丢失那个 bug 正是"提示词长"造成的,
 *    若为提速而精简 report 的输入,就等于把要测的现象本身测没了。
 * 2. **播种运行必须被隔离**。产物混了别次运行的数据 → 与 scenario 运行同等对待:
 *    `manifest.test_scenario=true`、不进知识层、不进温度计历史。
 * 3. **陈旧夹具必须拒绝**。这些数据是逐日变化的,拿上周的数配今天的数,
 *    硬测试会**因为错误的原因通过或失败** —— 那比慢更糟。默认只允许同一数据日。
 *
 * ⚠️ 夹具运行**不能替代**发布前那次完整运行(见 docs/release-checklist.md 第 3 步)。
 *
 * 🔴 **完整性校验能证明什么、不能证明什么**(Codex fixture-r1 纠正了我原来的过度声称):
 *   `files` 的逐文件哈希与 `tree_sha256` **都写在同一个可改的清单里** —— 能改文件的人也能改清单。
 *   所以它只能检出**意外损坏、手滑改动、与清单不一致的残留文件**,**不能**证明数据没被蓄意伪造。
 *   真要防蓄意篡改,得把摘要放到清单之外(签名 / 仓库固定 digest),本项目没有这个威胁模型:
 *   夹具在开发者自己的 `.local/` 里,且**播种运行本身已按测试运行隔离**、绝不进知识层。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";


export const FIXTURE_MANIFEST = "_fixture.json";
/** 夹具收录的目录:fetch(含 _ledger / _plan)/ raw / calcs / stages —— loadRun 就是从这些派生证据与账本的 */
export const FIXTURE_DIRS = ["fetch", "raw", "calcs", "stages"] as const;

/**
 * 决定"夹具产物长什么样"的口径指纹。任一不同,前四阶段的产物就与本次运行不是一回事
 * (Codex fixture-r1 P2):registry / endpoint scope 决定取了哪些端点,calc 版本决定阶段里那些计算的形状。
 * registry / endpoint scope / **calc_version 三者都强制**;`repo_version` **只记录不强制** ——
 * 开发期几乎每次提交都变,强制会让夹具永远用不上。
 * ⚠️ 早先只强制前两者、却在注释里说"calc 版本决定计算形状",是自相矛盾(Codex fixture-r2 P2),已改为强制。
 */
export interface FixtureFingerprint {
  registry_version: string;
  endpoint_scope: string;
  calc_version: string;
  repo_version: string;
}

export interface FixtureManifest {
  version: 1;
  symbol: string;
  market: string;
  fingerprint: FixtureFingerprint;
  /** 夹具里已经"跑过"的阶段;这些阶段在使用夹具的运行里会被跳过 */
  stages: string[];
  created_at: string;
  /** 数据日(Asia/Shanghai 的日历日),新鲜度判据 */
  data_day: string;
  source_run_id: string;
  files: Record<string, string>;
  tree_sha256: string;
}

export class FixtureError extends Error {}

const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

/**
 * 清单里的相对路径必须"老实":只在 FIXTURE_DIRS 之下、无 `.` / `..` / 空段 / 反斜杠 / 绝对路径。
 * 🔴 不校验就能靠一条 `../../x` 把文件播种到运行目录**之外**(Codex fixture-r1 P1)。
 */
/**
 * 路径的每一层都不能是符号链接,且最终必须仍落在**解析后的根**之内。
 *
 * 🔴 两个都要,少一个都不对:
 * - 只做词法比较 → 夹具里的 `fetch/x` 是指向外面的链接照样被读(Codex fixture-r2);
 * - 反过来"祖先里有链接就拒绝"则**过度严格**:macOS 的 `/var` 本身就是指向 `/private/var` 的链接,
 *   而 `os.tmpdir()` 就在它下面 —— 那样写会把正常系统路径全拒掉(本机测试当场抓到)。
 * ⇒ 正确语义是:**先 realpath 根**(容忍良性的祖先链接),再逐层拒绝 rel 内部的链接,
 *   最后复核解析结果没有越出解析后的根。
 */
export function assertNoSymlink(root: string, rel: string): void {
  let base: string;
  try { base = fs.realpathSync(path.resolve(root)); } catch { base = path.resolve(root); }
  let cur = base;
  for (const seg of rel.split("/")) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { break; }   // 还不存在的层(播种时的目标)无需检查
    if (st.isSymbolicLink()) throw new FixtureError(`路径里有符号链接,拒绝:${path.relative(base, cur)}`);
  }
  let resolved: string;
  try { resolved = fs.realpathSync(path.dirname(cur)); } catch { resolved = path.dirname(cur); }
  if (resolved !== base && path.relative(base, resolved).startsWith("..")) {
    throw new FixtureError(`路径解析后越出根目录:${rel}`);
  }
}

export function assertSafeRel(rel: string): void {
  if (typeof rel !== "string" || !rel) throw new FixtureError(`夹具清单里有空路径`);
  if (rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) throw new FixtureError(`夹具清单里有非法路径:${rel}`);
  const parts = rel.split("/");
  if (parts.some((x) => !x || x === "." || x === "..")) throw new FixtureError(`夹具清单里有非法路径段:${rel}`);
  if (!(FIXTURE_DIRS as readonly string[]).includes(parts[0])) throw new FixtureError(`夹具清单里的路径不在 ${FIXTURE_DIRS.join(" / ")} 之下:${rel}`);
}

/** 两个目录不得相同或互为祖先 / 后代(用解析后的真实路径判,能穿透良性链接) */
export function assertDisjoint(a: string, b: string, labelA: string, labelB: string): void {
  const rp = (x: string) => { try { return fs.realpathSync(path.resolve(x)); } catch { return path.resolve(x); } };
  const A = rp(a), B = rp(b);
  if (A === B || !path.relative(A, B).startsWith("..") || !path.relative(B, A).startsWith("..")) {
    throw new FixtureError(`${labelA}与${labelB}不得相同或互相包含:${A} / ${B}`);
  }
}

/** Asia/Shanghai 的日历日 —— 与项目其它地方的"今天"口径一致 */
export function shanghaiDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 递归列出目录下的相对路径(排序,保证 tree_sha256 确定) */
export function listFiles(root: string, sub: string): string[] {
  const base = path.join(root, sub);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p));
    }
  };
  walk(base);
  return out.sort();
}

/** 对文件清单算整体哈希:内容变了、少了一个文件、多了一个文件,都会变 */
export function treeHash(files: Record<string, string>): string {
  return sha(Object.keys(files).sort().map((k) => `${k}:${files[k]}`).join("\n"));
}

/**
 * 从一次真实运行里抽夹具。**只抽 FIXTURE_DIRS**:report.md / evidence.json / manifest.json /
 * events.jsonl 都是终态产物,不属于"前几个阶段的中间结果",带进去只会让播种运行的产物真假混杂。
 */
export function createFixture(runDir: string, outDir: string, opts: { stages: string[]; symbol: string; market: string; runId: string; now?: Date }): FixtureManifest {
  // 🔴 数据日必须取**来源运行**的开始时刻,不能取"现在" —— 今天拿三天前的运行建夹具,
  //    用创建时间当数据日会让新鲜度检查形同虚设(Codex fixture-r1 P2)。
  const srcManifest = path.join(runDir, "manifest.json");
  if (!fs.existsSync(srcManifest)) throw new FixtureError(`源运行缺 manifest.json,无法确定数据日与口径指纹:${runDir}`);
  let sm: { started_at?: unknown; symbol?: unknown; market?: unknown; run_id?: unknown; registry_version?: unknown; endpoint_scope?: unknown; calc_version?: unknown; repo_version?: unknown };
  try { sm = JSON.parse(fs.readFileSync(srcManifest, "utf8")); }
  catch (e) { throw new FixtureError(`源运行 manifest.json 不是合法 JSON:${e instanceof Error ? e.message : String(e)}`); }
  // 🔴 身份字段必须与来源运行一致 —— 否则夹具可以谎报它是谁的数据(Codex fixture-r3 P1:
  //    从某个主体的运行里"造"一个声称是另一主体的夹具,指纹相同就能全程通过)。
  if (String(sm.symbol ?? "") !== opts.symbol || String(sm.market ?? "") !== opts.market) {
    throw new FixtureError(`来源运行是 ${String(sm.symbol ?? "?")}.${String(sm.market ?? "?")},与声称的 ${opts.symbol}.${opts.market} 不符`);
  }
  if (String(sm.run_id ?? "") !== opts.runId) throw new FixtureError(`来源运行 run_id ${String(sm.run_id ?? "?")} 与声称的 ${opts.runId} 不符`);
  const startedAt = typeof sm.started_at === "string" ? new Date(sm.started_at) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) throw new FixtureError(`源运行 manifest.started_at 缺失或不合法,无法确定数据日`);
  const fingerprint: FixtureFingerprint = {
    registry_version: String(sm.registry_version ?? ""), endpoint_scope: String(sm.endpoint_scope ?? ""),
    calc_version: String(sm.calc_version ?? ""), repo_version: String(sm.repo_version ?? ""),
  };
  for (const s of opts.stages) {
    const f = path.join(runDir, "stages", `${s}.json`);
    if (!fs.existsSync(f)) throw new FixtureError(`源运行缺少阶段产物 stages/${s}.json:${runDir}`);
  }
  // 🔴 下面第一件事就是递归删 outDir —— 若 outDir 与来源运行目录相同或互为祖先 / 后代,
  //    等于先把来源(甚至整个 runs 目录树)删掉再去读它(Codex fixture-r4 P1)。必须先拦。
  assertDisjoint(runDir, outDir, "来源运行目录", "夹具输出目录");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const d of FIXTURE_DIRS) {
    for (const rel of listFiles(runDir, d)) {
      // 只收夹具阶段的 stages/*.json —— 把 risk / report 的产物也带进去就等于"答案已经写好了"
      if (rel.startsWith(`stages${path.sep}`) && !opts.stages.some((s) => rel === path.join("stages", `${s}.json`))) continue;
      const buf = fs.readFileSync(path.join(runDir, rel));
      const dst = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
      files[rel.split(path.sep).join("/")] = sha(buf);
    }
  }
  if (!Object.keys(files).length) throw new FixtureError(`源运行没有可收录的产物:${runDir}`);
  const now = opts.now ?? new Date();     // 只取一次:两次 new Date() 跨过上海午夜会让两个字段不自洽(Codex fixture-r1 P3)
  const m: FixtureManifest = {
    version: 1, symbol: opts.symbol, market: opts.market, fingerprint, stages: [...opts.stages],
    created_at: now.toISOString(), data_day: shanghaiDay(startedAt),
    source_run_id: opts.runId, files, tree_sha256: treeHash(files),
  };
  fs.writeFileSync(path.join(outDir, FIXTURE_MANIFEST), `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

export function readFixture(dir: string): FixtureManifest {
  const f = path.join(dir, FIXTURE_MANIFEST);
  if (!fs.existsSync(f)) throw new FixtureError(`不是夹具目录(缺 ${FIXTURE_MANIFEST}):${dir}`);
  let m: FixtureManifest;
  try { m = JSON.parse(fs.readFileSync(f, "utf8")) as FixtureManifest; }
  catch (e) { throw new FixtureError(`夹具清单不是合法 JSON:${f}(${e instanceof Error ? e.message : String(e)})`); }
  if (m?.version !== 1 || !m.files || typeof m.files !== "object" || !Array.isArray(m.stages) || !m.stages.length || !m.fingerprint) {
    throw new FixtureError(`夹具清单格式不对(需 version=1 / files / 非空 stages / fingerprint):${f}`);
  }
  return m;
}

/**
 * 校验夹具**一致性**:路径合法 + 逐文件哈希 + 整体树哈希 + 不允许有清单之外的多余文件。
 * ⚠️ 这是"检出损坏与漂移",不是"证明没被伪造" —— 原因见文件头。多余文件要拦是因为它多半意味着
 * 上一次夹具没清干净或有人手工放了东西,那种残留会以静默的方式改变播种结果。
 */
export function verifyFixture(dir: string): FixtureManifest {
  const m = readFixture(dir);
  const onDisk = new Set(FIXTURE_DIRS.flatMap((d) => listFiles(dir, d)).map((p) => p.split(path.sep).join("/")));
  const declared = new Set(Object.keys(m.files));
  for (const rel of declared) {
    assertSafeRel(rel);                       // 先挡路径越界,再谈哈希
    assertNoSymlink(dir, rel);                // 词法校验挡不住符号链接
    const p = path.join(dir, ...rel.split("/"));
    if (!fs.existsSync(p)) throw new FixtureError(`夹具缺文件:${rel}`);
    const got = sha(fs.readFileSync(p));
    if (got !== m.files[rel]) throw new FixtureError(`夹具文件已被改动:${rel}(期望 ${m.files[rel].slice(0, 12)},实际 ${got.slice(0, 12)})`);
  }
  const extra = [...onDisk].filter((p) => !declared.has(p));
  if (extra.length) throw new FixtureError(`夹具里有清单之外的文件(可能被塞入伪造数据):${extra.slice(0, 5).join(", ")}`);
  const tree = treeHash(m.files);
  if (tree !== m.tree_sha256) throw new FixtureError("夹具清单自身被改动(tree_sha256 对不上)");
  return m;
}

/** 夹具是否与"今天"同一数据日 —— 数据逐日变化,跨日复用会让硬测试因错误的原因通过或失败 */
export function fixtureFreshness(m: FixtureManifest, now: Date = new Date()): { fresh: boolean; today: string } {
  const today = shanghaiDay(now);
  return { fresh: m.data_day === today, today };
}

/** 把夹具内容播种进(已建好的空)运行目录。调用前必须先 verifyFixture。 */
export function seedRunDir(fixtureDir: string, runDir: string, m: FixtureManifest): string[] {
  const seeded: string[] = [];
  for (const rel of Object.keys(m.files).sort()) {
    assertSafeRel(rel);                       // 纵深:即使调用方漏了 verify,也不许写出运行目录
    assertNoSymlink(fixtureDir, rel);         // 源:不许跟随链接读到夹具外
    assertNoSymlink(runDir, rel);             // 目标:不许经由链接写到运行目录外
    const src = path.join(fixtureDir, ...rel.split("/"));
    const dst = path.join(runDir, ...rel.split("/"));
    if (path.relative(path.resolve(runDir), path.resolve(dst)).startsWith("..")) throw new FixtureError(`播种目标越出运行目录:${rel}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    // 🔴 verify 与 copy 之间源文件仍可能被换掉(TOCTOU,Codex fixture-r3 P1)——
    //    复制完按清单重新核一次**落地内容**的哈希,内容对不上就作废。
    const got = sha(fs.readFileSync(dst));
    if (got !== m.files[rel]) throw new FixtureError(`播种落地内容与清单不符(校验后被换过?):${rel}`);
    seeded.push(rel);
  }
  return seeded;
}
