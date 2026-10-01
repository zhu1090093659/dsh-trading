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
`scripts/coverage-baseline.json` 比较，任何指标下降即红。基线：
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

- **`pnpm contract-id:check`** —— id 冻结面门禁：源码里不得写死 orderId 字面量。契约是「只比较不解析」，一旦某处写死或解析，它就获得了语义，格式从此不能改。契约包自身的 factory/正则与带 `id-gate-allow` 标注的测试样本除外（已实测 725 个文件无违规）。
  **补记一条教训**：这个门禁是 P4 步骤 1 建的，但**建好后一直没接进 CI** —— 一个不跑的门禁与散文无异。本轮补上。
- **`node scripts/e2e-smoke.mjs`** —— 端到端冒烟包：带外 A0 在业务面全挂时仍可用、确定性 shadow 跑批逐字复现基线。**CI 里默认不带网络项**（`--with-network` 才加真实行情），所以不出网的 runner 也能绿；网络项留给人工。

**为什么端到端冒烟必须进 CI**：本仓已有 **7 个「单元测试全绿、真实路径坏掉」的先例**（解码钩子缺失、乱序判定全局、基准不刷新、符号写法不一致、界面丢弃未知卡片、契约包引 node:crypto 使浏览器构建失败、`/v1/assets` 漏传 accept-encoding）。它们的共同点是：**单测喂的是我们自己造的输入**，只有真实链路才现形。细节见 [路线端到端冒烟包](2026-10-01-route-e2e-smoke-pack.md)。

**未验证**：这两步只有在真实 CI 跑过一次才算验证（本地等价命令是绿的，但 CI 的 Node 版本是 22、`setup-node` 的 pnpm 缓存路径与本地不同）。**在 CI 真跑之前，我不把"已进 CI"说成"已在 CI 生效"。**
