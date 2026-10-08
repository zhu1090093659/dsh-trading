# Agent Note: 测试卫生与覆盖棘轮 + CI 分层（business-testing-ci 落地）

Status: implemented

## Problem

按 business-testing-ci 标准盘点本仓测试与 CI/CD，六处缺口都有具体证据：

1. **测试规范零机器强制。** 1565 条用例中 0 条以角色开头、0 条带 Given/When/Then
   标记；52 个测试文件用 `vi.fn`/`vi.mock`/`spyOn`（217 处调用）当通用打桩；
   5 处真实 `setTimeout` 等待（jin10 轮询 20/25ms、holdings fx 20ms、kit-cn/hk
   在途合并 10ms）——规范只活在文档里，新代码继续累积。
2. **两条测试通道从未进 CI。** CI 跑的是 `pnpm -r test`（只覆盖 workspace 包）：
   `desktop/tests/*.test.mjs`（21 例 node:test，验 runtime payload 解包与 host
   符号规范化，打包的正是它们验证的产物）与 `scripts/*.test.mjs`（20 例门禁
   自测）都不在 workspace 内，实际只在本地 root `pnpm test` 被扫到。
3. **零覆盖率度量。** 无任何 coverage 配置，分支覆盖率不可见，回归无护栏。
4. **CI 无并发取消。** 连推三次就让三份全矩阵排队，反馈落在最旧提交上。
5. **发版闸门弱于 PR 闸门。** `desktop-release.yml` 只跑 install+build+test，
   typecheck / i18n 门禁只在 PR CI 跑——直接推 tag 可绕过它们发版。
6. **无 Tier 2 层。** 覆盖率、抖动探测、周期性全矩阵复核都无处安放。

## Decision

**1. 测试卫生棘轮 `scripts/test-audit.mjs`（五规则，逐文件计数）。**
`mock`（vi.fn/vi.mock/vi.spyOn/jest.*）、`sleep`（setTimeout/setInterval/sleep/
delay；`setImmediate` 只让出事件循环、不算等待，故不计入）、`bdd-title`（标题须
以角色开头）、`bdd-gwt`（正文须含 Given/When/Then）、`weak-assert`（须有断言，
`expect*` 前缀的辅助断言函数也算）。存量债入 `scripts/test-audit-baseline.json`：
**任何规则总量上升、任一已基线文件计数上升、或新文件带债，一律 exit 1**——单文件
计数是必要的，总量持平会掩盖「A 清债、B 新欠」的搬运。`--update` 只降不升
（`--force` 强升）。

两处刻意的口径选择（本仓是中文单语仓，规则按可读性而非字面照搬）：
- **角色词表 = 英文规范词（user/customer/admin/guest/operator）+ 中文等价词
  （用户/客户/管理员/访客/运营）**。标准要求 role-anchored 标题，中文仓里强迫
  英文前缀会与全仓标题语言打架，两种都认才是同一意图在本仓的落地。
- **GWT 标记限英文**（Given/When/Then）：中文正文可中文，标记词保持英文以免
  「当」这类单字在正常中文里误命中。

`bdd-title` 与 `bdd-gwt` 的基线等于全量 1565——它们对存量的语义就是**只堵新增**，
不是「当前合格」。基线数字公开写在这里，谁要收紧就按包清债后 `--update`。

`scripts/test-audit.test.mjs`（9 例）是唯一豁免扫描的测试文件：它的夹具必须内联
真实违规样本（`vi.fn`、`setTimeout`、无角色前缀标题），否则无法证明规则真的命中。
豁免理由写在扫描器常量旁，新增豁免必须同样写理由。

**2. 清掉 5 处真实等待（棘轮 sleep 基线因此为 0）。**
- kit-cn / kit-hk 的「并发首次轮询 → in-flight 合并」：两个 fetcher 都在入口同步
  调用 memo 化的 lookup（`fetchCninfoOrgId` / `fetchHkexStockId`），`inflight.set`
  也是同步的，而 `Promise.all([a, b])` 的数组元素按序同步求值——第一路注册后第二路
  必命中注册表。那 10ms 从不参与正确性，直接删掉。
- holdings fx 在途去重同理（`inflight.set(base, created)` 同步），20ms 删除。
- jin10 `subscribeTicker` 是**真**定时器（`setInterval(tick, pollMs)`），改用
  `vi.useFakeTimers()` + `advanceTimersByTimeAsync` 确定性推进假时钟；顺带把
  `vi.fn` 打桩换成计数假 feed，mock 债一并-1。
- **红探针实证**：破坏 fx 的 in-flight 读取 → 该用例 `expected 4 to be 2` 变红；
  把 jin10 `dispose()` 改成空函数 → `quotes` 从 1 涨到 11 变红。删除等待后用例
  仍有牙齿，不是「删了等待也照样绿」。

**3. 两条孤儿测试通道进 CI。** 新增 `pnpm test:scripts`（`vitest run scripts`，
20 例）与 `pnpm test:desktop`（`node --test "desktop/tests/*.test.mjs"`，21 例），
在 ci.yml 的静态门禁 job 与 `desktop-release.yml` 的两个发布 job 里各跑一次。
desktop 是独立 npm 工程（`pnpm-workspace.yaml` 只收 `packages/*`），`pnpm -r test`
结构上覆盖不到它。

**4. 覆盖率棘轮 `scripts/coverage-gate.mjs`（v8，all=true）。**
逐包跑 `vitest run --coverage`（`--coverage.all` + `include=src/**`，未测文件按
0% 计入，才是真实覆盖面），按 metric 的 total/covered 求和聚合，与
`scripts/coverage-baseline.json` 比较，任何指标下降即红。**任何一个包产出不了覆盖率报告同样即红**
（2026-10-02 修，见下「门禁可信度三修」）。基线：
**branches 73.85% / lines 61.96% / functions 71.47% / statements 61.96%**。

为什么逐包而不是 root 单进程：`pnpm -r test` 与 root `vitest run` 语义不同——
root 进程读不到 `packages/client-ui-trading/vitest.config.ts` 的 `setupFiles`，
会让 tasks 账本写进真实 home 并让并行文件抢锁。覆盖率必须与真实测试入口同口径。
容差 0.2pp：逐包并行下个别边界分支计数在两次运行间会差 1~2 个（11200 量级上约
0.01pp），门禁要是指纹不是骰子，真实回归（少跑一个测试文件掉 1pp 以上）照样红。

**5. CI 分层。** `ci.yml` 拆成两个 job：`static-gates`（ubuntu 单点跑 typecheck /
i18n / test:audit / test:scripts / test:desktop，平台无关，失败不必等矩阵）与
`test`（ubuntu 22/24 + windows 22 矩阵，保留 2026-09-06 的 Windows 信号前移
决策，不因提速删除）；新增 `concurrency` 取消同 ref 旧跑。新增
`nightly.yml`（`schedule` + `workflow_dispatch`）：覆盖率棘轮、同一条全量测试
串跑三遍的抖动探测（ubantu + windows）、desktop 用例。

**6. 发版闸门与静态门禁同源。** `desktop-release.yml` 的 npm-publish job 补齐
typecheck-gate / i18n / test:audit / test:scripts / test:desktop；build-desktop job
在打包前跑 desktop 用例。发版必须比 PR 更严，不能更松。

## Alternatives considered

- **一次性把 1565 条用例改成 BDD 命名 + GWT 结构**：落选。这是上千文件的机械
  改写，与本次「优化体系」的风险收益不成比例，且会掩盖真实行为改动；棘轮用
  同样确定性达到「只堵新增」的效果，与 `typecheck-baseline.json` 是同一套纪律。
- **用 eslint 插件（如 eslint-plugin-jest / no-restricted-syntax）承载这些规则**：
  落选。本仓全部门禁（typecheck / i18n / 覆盖率）都是 `scripts/` 下带基线的自研
  棘轮脚本，无 eslint 依赖；引入第二套 lint 体系会增加依赖与配置面，且 eslint
  规则拿不到「逐文件棘轮基线」这种本仓的核心形态。
- **root 单进程 vitest 统跑以提速（14s vs 35s）并顺带得到全仓覆盖率**：落选。
  会丢 `setupFiles`（见 Decision 4），是正确性问题不是速度问题。
- **覆盖率只在 nightly 报告、不做门禁**：落选。没有门禁的度量会漂移；同时把它
  放在 nightly 而非 PR 静态门禁，是因为逐包 v8 all=true 是分钟级开销，塞进 Tier 1
  会破坏 3-5 分钟反馈预算——这是本变更唯一一处刻意把标准里的「PR 覆盖率护栏」
  降到「夜间护栏」的地方。
- **把 Windows 从 PR 矩阵移到 nightly 提速**：落选。2026-09-06 的决策正是因为
  v0.1.2/v0.1.4 两次都在发版当天才暴露 Windows 专属故障；夜间才发现的 Windows
  回归会再次把成本推到发版日。

## Consequences

- 新测试要能过 `pnpm test:audit`：角色前缀标题 + Given/When/Then 正文 + 真断言 +
  不用通用 mock / 真实等待。失败信息直接指出是哪个文件哪条规则从多少涨到多少。
- 扫描树容错：`walk` 遇到 `statSync` 抛错的入口（悬空符号链接、不可读路径）跳过而不是
  让门禁崩——git-ignored 暂存物 `desktop/resources/runtime` 的官方 bin 链接被裁剪后会
  悬空，那是构建产物不完整，不是测试债；门禁只对能读到的用例文件计数。
- 覆盖率从 0 变成可观测、可棘轮；73.85% 分支离标准的 90% 还有距离，诚实数字在
  基线里，失败路径审计的优先名单由 `pnpm coverage:check` 直接按包打印。
  该指标是回归护栏，不是质量合格证——为什么有未覆盖分支仍须按标准 §5 清单人工审计。
- 发版管线变严：直接推 tag 不再能绕过 typecheck / i18n / 测试卫生门禁。若某次
  合法的紧急发版撞上既有基线债，必须先清债或显式用 `--update`/`--force` 改基线
  并在 PR 说明，不能靠跳步发出去。
- `desktop/tests` 与 `scripts/test-*.mjs` 从此在每次 PR、每次发版都被执行；
  此前它们只活在开发者本机。
- 抖动探测三连跑会把间歇失败变成红——这是刻意的：间歇失败是缺陷，不是重跑噪音。

## static-gates 的两个新成员（2026-10-01）

Tier 1 的 `static-gates` job 里新增两步（见 .github/workflows/ci.yml）：

- **`pnpm contract-id:check`** —— id 冻结面门禁：源码里不得写死 orderId 字面量。契约是「只比较不解析」，一旦某处写死或解析，它就获得了语义，格式从此不能改。契约包自身的 factory/正则与带 `id-gate-allow` 标注的**测试文件**里的样本除外；2026-10-02 实测 806 个文件无违规，同日收紧了两处绕过口，见下「门禁可信度三修」。
  **补记一条教训**：这个门禁是 P4 步骤 1 建的，但**建好后一直没接进 CI** —— 一个不跑的门禁与散文无异。本轮补上。
- **`node scripts/e2e-smoke.mjs`** —— 端到端冒烟包：带外 A0 在业务面全挂时仍可用、确定性 shadow 跑批逐字复现基线。**CI 里默认不带网络项**（`--with-network` 才加真实行情），所以不出网的 runner 也能绿；网络项留给人工。

**为什么端到端冒烟必须进 CI**：本仓已有 **7 个「单元测试全绿、真实路径坏掉」的先例**（解码钩子缺失、乱序判定全局、基准不刷新、符号写法不一致、界面丢弃未知卡片、契约包引 node:crypto 使浏览器构建失败、`/v1/assets` 漏传 accept-encoding）。它们的共同点是：**单测喂的是我们自己造的输入**，只有真实链路才现形。细节见 [路线端到端冒烟包](../process/2026-10-01-route-e2e-smoke-pack.md)。

**未验证**：这两步只有在真实 CI 跑过一次才算验证（本地等价命令是绿的，但 CI 的 Node 版本是 22、`setup-node` 的 pnpm 缓存路径与本地不同）。**在 CI 真跑之前，我不把"已进 CI"说成"已在 CI 生效"。**

### 第三个新成员：`pnpm home-guard:check`（2026-10-01 同日）

`static-gates` 现在是 16 步，最后三步依次是 `node scripts/e2e-smoke.mjs`、`pnpm home-guard:check`（前者端到端冒烟、后者读 DSH_HOME 的脚本必须带守卫）。判据与理由见 [home 契约](../process/2026-09-08-separate-dsh-home.md) 的"home 守卫门禁"一节。

## 统一门禁入口 gates:all（2026-10-01）

scripts/gates-all.mjs 顺序跑 14 条门禁，**显式收集每条退出码**，任一条失败 ⇒ 整体 exit 1；末尾打印红绿表，失败时附该门禁输出尾部 8 行。

**存在理由（一句话）**：本会话两次带着红灯提交，根因都不是门禁没发现，而是**跑门禁的脚本没判退出码** —— "打印了红字"与"这一步算失败"之间有缝。这个脚本把缝焊死。

支持 --only a,b,c（子集）、--with-network（透传给 e2e:smoke）、--self-test（用一个必然失败的命令验证退出码传播）。

**全量实测**：14 通过 / 0 失败，exit 0（build 21.9s / -r test 31.7s / coverage 30.2s / typecheck 32.1s / 其余 <1.4s）。

**用法**：收尾一律 `pnpm gates:all`。

### gates-all 的两条性质（自测进 CI）

门禁工具自己也会犯错，所以它的两条性质现在由 `scripts/gates-all.test.mjs`（进 `test:scripts`）断言：

1. **失败会传播** —— `--self-test` 内部跑一个 `process.exit(3)` 的伪门禁，断言整体判定为失败（不许"红字但 exit 0"）；
2. **选不中要报错** —— `--only 拼错的名字` 必须 exit 2 并说明原因。**这条是新发现的漏洞**：初版 `--only bogus` 会选中 0 条门禁然后输出"全部通过"，**门禁工具自己空洞成功**（最讽刺的一种）。

实测：`--only no-such-gate` ⇒ `✗ 没有选中任何门禁：检查 --only 的名字`、exit 2；`--self-test` ⇒ exit 0；`--only home-guard:check` ⇒ 跑 1 条并绿。

## CI 接线检查 ci-wiring:check（2026-10-01）

`scripts/ci-wiring-check.mjs` 检查 workflow 里引用的**每个 pnpm 脚本与 node 脚本是否真的存在**。

**堵的方向与本会话此前发现的那个相反**：此前是"门禁建好了却没接进 CI"（contract-id:check）；这里堵的是"CI 里写了但脚本没了"（改名、删除、手误）—— 后者的后果是 **push 之后 CI 才红**，而那时人已经走了。**本地能查的事不该留给 CI。**

**实现要点（第一版踩坑）**：`node scripts/x.mjs` **必须按所在步骤的 `working-directory` 解析**。第一版没做，于是把 `desktop-release.yml` 里 `working-directory: desktop` 下的 `node scripts/verify-runtime-toolchain.mjs` 误报成断裂（实际文件在 `desktop/scripts/`）。自测里专门有一条守着这个语义，另一条守着"别把守卫修成永真"（子目录下真缺文件时仍要报错）。

**实测**：3 个 workflow、18 处 pnpm 脚本、8 处 node 脚本 ⇒ **接线完整**，exit 0。自测 3 例（进 `test:scripts`）。

### 覆盖方向 + 一次 **grep 假零命中**事故（2026-10-01）

`ci-wiring-check.mjs` 现在查**两个方向**：① 引用完整性（workflow 里写的脚本必须存在，按步骤的 `working-directory` 解析）；② **覆盖完整性** —— 一份 `MUST_BE_WIRED`（13 条）必须真的出现在 CI 或 `gates:all` 里，而**不进 CI 的门禁必须写明原因**（`INTENTIONALLY_UNWIRED`：`ui:check` 需 headless Chrome 真起实例、`bot-closure:check` 需已构建的 bot profile）。

**事故记录（值得单独记）**：本轮我用 `grep -rn "e2e\|smoke" .github/` 得到**零命中**，据此几乎写下"我此前记录 e2e-smoke 已进 CI 是错的"这条更正 —— 而 `tools.read` 打开 ci.yml 一看，**第 69 行就是 `node scripts/e2e-smoke.mjs`**（contract-id 在 64、home-guard 在 74）。改用 node 精确复核后确认：**三条门禁确实都在 CI 里，我原来的记录是对的，那次 grep 才是错的**。

**教训**：当一次搜索对"你认为存在的东西"报告"不存在"时，**必须换一种方法复核再下结论**（读文件 / 用 node 扫），否则会把一条假更正写进仓库 —— 这比不写更正更糟。本会话的同类事故已累计：摘要不可靠（3 次）、单次搜索不可靠（1 次）。

### 文档相对链接门禁（2026-10-01）

`scripts/docs-link-check.mjs`：markdown 里的 `](相对路径)` 必须指向存在的文件。**断链不会报错**，只会让后人顺着链接找不到那份 Owning Note —— 于是要么重造一份（违反"一个事实只有一个家"），要么照旧做法继续错下去。

**两条踩坑（都值得记）**：

1. **本仓两种链接写法并存**：相对**所在文件** 与 相对**仓库根**（如 `](.agents/notes/…)`）。第一版只按文件目录解析 ⇒ 23 条里大半是误报。判据改成"先按文件解析、失败再按仓库根解析，**两者都不存在**才算断链"。
2. **不要在同一步里"改完就 --update 基线"**：我修 4 条链接时把 `process/x.md` 写成了相对文件目录的错误形态（正确是 `../process/x.md`），随即 `--update` 把自己造的 2 条断链**洗进了基线**。识破方式很朴素：**核对算术** —— 22 条修掉 4 条就该是 18，而基线报 20 ⇒ 有 2 条是新造的。改对后基线回到 18，算术对上。

**存量 18 条入基线**（archived 笔记里的历史断链 + bug-fix 笔记里 `../../desktop/…` 少写两级的路径），与 `typecheck-baseline.json` / `test-audit-baseline.json` 同一惯例：只拦新增。

**基线记账改为仓库根相对路径（2026-10-09 修）**：原先基线里存的是**绝对路径**（`/Users/<人>/code/dsh-trading/.agents/…`）。成因：`fileURLToPath(new URL('..', import.meta.url))` 带尾分隔符，`file.replace(ROOT + '/', '')` 里的 `ROOT + '/'` 成了 `…/dsh-trading//` 永不匹配，前缀剥不掉。后果在主 checkout 上看不见：本地全绿，一旦 checkout 落在别的绝对路径（CI 的 `/home/runner/…`、任何 worktree、临时副本），**18 条存量全部对不上**（2026-10-09 用 `/tmp` 干净副本实测：基线只有 0/18 条匹配该根，门禁 exit 1 并把存量当新增报出）⇒ 门禁在 CI 上恒红。现在基线条目与报错**统一写仓库根相对路径**，与 checkout 位置无关；扫描根可用 `DOCS_LINK_ROOT` 覆盖（自测夹具用）。

**解析判据不动**（本次只归一记账，不放宽）：仍是「先按所在文件目录、再按仓库根，两者都不存在才算断链」。实测本仓 297 条相对链接中 256 条**只**按文件目录能解析（`docs/README.md → ./guides/…`、笔记间 `../feature/…`），放宽成只按仓库根会把它们整体误报——所以保留双解析、只把记账口径从绝对路径改成仓库根相对。自测 `scripts/docs-link-check.test.mjs`（4 例）：真的拦新增、存量入基线后不重复报、同一条基线换个绝对路径仍对得上、文件相对链接不被放宽掉。

## 门禁可信度三修（2026-10-02）

验收（`.local/acceptance/v5-hygiene.md` §3.1/§3.3、`.local/acceptance/v4-p4-p5.md` F4）实测到几处
**门禁自己的可信度**缺口，同日修掉：

**1. `coverage:check` 曾把"未验证"打成"通过"。** 某个包收集失败（依赖没构建、import 路径坏）时，
旧版把它 push 进 failures 就 `continue`（等于移出聚合），判红时又只看 dropped ⇒ 该包的覆盖率
**凭空消失**（不是变成 0）、剩余包的百分比反而可能上升，最后打印「通过（无指标下降）」并 exit 0。
现在 `judge()` 把 failures（无报告的包）与 dropped（低于基线）**一起判红**，输出点名到包；
`--update` 同样拒绝把无报告的包写进基线 —— 把"未验证"固化进基线等于把它洗成"已验证"。
为可复跑新增测试缝：`--packages-dir` / `--coverage-dir` / `--baseline` / `--vitest-bin` /
`--reuse-reports` / `--only=a,b`（子集模式不与仓库级基线比百分比，但"每个选中的包都必须有报告"照旧判红）。
自测 `scripts/coverage-gate.test.mjs`（7 例）用**临时仓库根**构造"某包无报告"，不跑真覆盖率。

**2. 真跑门禁的用例曾把机器负载算成代码缺陷。** `scripts/gates-all.test.mjs` 里 `--only home-guard:check`
那条真的要起子进程跑门禁（实测 4.5~7.7s），vitest 默认超时 5000ms ⇒ 空闲绿、并发假红
（验收实测 `1 failed | 79 passed`）。现在该用例显式 `60_000ms` 上界：**是上界不是期望耗时**，
真卡死照样红，只是不再把负载抖动算成回归。任何"真的起子进程跑门禁"的 scripts/ 用例同理。

**3. `contract-id:check` 的两个绕过口。** `id-gate-allow` 原先对**任意文件**豁免（生产源码里加一行
注释即可关掉门禁）⇒ 现在只对测试文件（`test/`、`tests/` 目录，或 `*.test.*`/`*.spec.*` 命名）生效；
字面量正则原先只认 v4 UUID（v1/v5 形态与全零占位漏网）⇒ 现在匹配「`ord_` + 任意版本 UUID」与
「`ord_` + 6 位以上十六进制短字面量」，裸前缀、模板拼接（`ord_` 后接插值）、非十六进制后缀仍不误报。
`packages/contract/test/contract.test.ts` 进整文件豁免（它断言 `isOrderId` 必须拒绝哪些形态，样本必须能被写出来）。

**4. 主模块守卫的静默空转（同批修）。** `coverage-gate.mjs` 与 `contract-id-gate.mjs` 结尾的
"是否主模块"判断原先直接比较 `process.argv[1]` 与 `import.meta.url`：经符号链接调用（macOS 的
`/tmp`、`/var` 都是链接）时两者文字形态不同 ⇒ main() 根本不执行，进程**零输出、exit 0** ——
门禁最坏的失败形态（"看起来跑过了"）。两侧现在都先 `realpathSync` 再比，并有回归用例。

**验证（2026-10-02，`d9eeb3bf`）**：`npx vitest run scripts/coverage-gate.test.mjs scripts/gates-all.test.mjs
scripts/contract-id-gate.test.mjs` = 3 文件 / 14 例全绿；`node scripts/test-audit.mjs --check` 无新增测试债；
`node scripts/contract-id-gate.mjs` = 806 文件 / 0 违规；旧版对"两个包都没有报告"的场景实测 exit 0 +
「通过（无指标下降）」，新版 exit 1 并点名两个包。

## KDAS 菜单用例：先按 owner 裁决入基线，同日清债并继续下调基线（2026-10-08）

`packages/client-ui-trading/test/kdas-menu.test.ts`（随 KDAS 关键日图表右键菜单在 `fe1f6d14` 落地）带来的 18 条 `bdd-title` + 18 条 `bdd-gwt` 从未登记进基线，该提交之后 HEAD 上的 `pnpm test:audit` 一直是红的。发现于 roadmap-crypto-perp 的集成门禁：用 `git archive d42cba14`（本任务之前的 HEAD）复现同样的红与同一个「新文件带债」条目，证明非该轮变更引入。

**第一步（owner 裁决）：整文件入基线，先不阻塞门禁。** `node scripts/test-audit.mjs --update --force`（棘轮默认只降，强升必须 `--force`，本条即那次显式强升）：

- 新增 `packages/client-ui-trading/test/kdas-menu.test.ts`：`bdd-title` 18 / `bdd-gwt` 18；
- 规则总量 `bdd-title` 1528→1541、`bdd-gwt` 1528→1540（同一次刷新顺带吸收了 4 个既有文件的清债下调：binance market-data 12→10、binance orderbook 3→2、okx public-market-data 26→25、okx trade 34→33/32）；
- `tests` 1704→1868：叶用例总数按现场重扫（旧值已陈旧，与违规计数无关）。

**第二步（同日，owner 追加要求）：当天清掉，不留长期挂账。** 该文件 18 条 leaf 的失败项只有结构两项——标题缺角色前缀、正文缺 Given/When/Then；断言本身是完整的（`weak-assert` 全程 0：每条 leaf 都是有具体期望值的 `toEqual`/`toBe`，无通用 mock、无真实等待）。因此改写只动标题与注释、不动任何断言与行为：18 条标题改成「用户…」开头，每条 leaf 正文补 `// Given` / `// When` / `// Then` 三段，把原注释里的场景写进标记。

改写后 `pnpm test:audit --update`（此时只降）把该条目整条移除：`bdd-title` 1541→1523、`bdd-gwt` 1540→1522。验证：`pnpm --filter @dshtrading/client-ui-trading exec vitest run test/kdas-menu.test.ts` = 18 passed；`pnpm test:audit` 通过；`pnpm gates:all` = 14 通过 / 0 失败（2026-10-08 实测）。

**棘轮语义不变**：那次 `--force` 只是当时不阻塞集成门禁的临时手段，债已在同一天清掉；该文件此后任何计数上升、或任何新文件带债，照旧红。


