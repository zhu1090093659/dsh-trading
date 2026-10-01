# 官方缝清单（三问逐条作答）

状态：**P0 交付（2026-10-01）**。本文件是 [bot-and-auto-trading.md](bot-and-auto-trading.md) §10「可以踩 / 不可踩」的执行细化——那里写的是结论，这里写的是**每条缝的可执行检测点**。

读法（设计文档 §10 的三问，缺一问即视为未满足）：

1. **它是不是官方承诺的契约**（文档级承诺，而非实现细节）？
2. **上游变更时我们会不会失败得响亮**？
3. **它静默失效时我们能不能看见**？

第 3 问是唯一的验收门槛：**答不出一个可执行检测点就是「未满足」**，不允许写「已评估」。判定列只有三种取值：`满足`（有可执行检测点且在 CI 里跑）、`部分满足`（有检测点但不覆盖该缝的失效形态）、`未满足`（没有检测点，已登记进 §C 缺口清单）。

官方版本锚：DSH cohort **0.2.0-rc.2**（`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 钉定），patch 引擎 `@deepseek-ai/cordis-plugin-loader@1.0.5`（实际解析版本见 `pnpm-lock.yaml`）。换 cohort 时本文件与 §C 一起重审。

---

## A. 我们依赖的官方缝

### A1 profile / bundle 组合（`@deepseek-ai/dsh-app-boot`）

- **依赖点**：10 个包的 `package.json` 声明 `dsh.bundle.patch`；profile 的 `dsh.profile.bundles` 有序列表（安装态 `$DSH_HOME/profiles/trading-web/package.json`、仓库内 `desktop/resources/runtime/profile-trading/package.json`、`desktop/scripts/build-runtime.mjs` 的 `PROFILE_BUNDLES`）。
- **① 契约**：官方文档级承诺。app-boot README：「A bundle's `dsh.bundle.patch` names one patch file or an ordered list of files; `bundlePatchFiles` validates the declaration and `bundlePatchPaths` resolves it to absolute paths; the layer concatenates their patch lists in that order.」
- **② 响亮程度：不响亮——这是本缝最危险的地方。** 同一段 README：「Bundle resolution, manifest, and patch-loading failures **skip that bundle without changing its selection**; the loaded profile lists each skip in `skippedBundles`, and the launcher prints them once per start with `reportSkippedBundles`.」⇒ 一个 bundle 解析失败**不会**让启动失败，只会被跳过并在启动日志里打印一次。行情面/工具面少一半而进程照常起来，是本项目最现实的静默失效形态。
- **③ 检测点**：
  - `pnpm patch-id:check`（`scripts/patch-id-gate.mjs` 的 **R5 层可达性**）：有 `cordis.patch.yml` 却没有 `dsh.bundle.patch` 声明的包直接红——这正是 2026-10-01 修掉的两处死层（`packages/dsh-i18n`、`packages/client-ui-masters-quotes` 的 patch 文件从不可达）；反向（声明了但文件不存在、声明为 bundle 却解析不到层）同样红。
  - `scripts/profile-config-preflight.sh <profile>`（安装态准入门禁）：死路径 / 身份漂移 / 闭包缺口 / 版本漂移四类漂移在 `plugin install` 前红。
  - 启动日志的 `skippedBundles`：官方出口，运维可见。
- **判定**：**部分满足**。静态层可达性与安装态漂移都有门禁，但**「本 profile 期望的 bundle 集合 ⊆ 实际加载的集合」没有我们自己的断言**——官方只在启动日志里打印一次，日志不是门禁。缺口见 §C-1。

### A2 profile peer 版本校验

- **依赖点**：每个包 `peerDependencies` 里的 `@deepseek-ai/dsh-*` 范围；`pnpm-workspace.yaml` 的 `autoInstallPeers` + `minimumReleaseAgeExclude`。
- **① 契约**：官方文档级承诺。README：「Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`. Every declared range must match; prereleases participate in range matching. … These checks use peer declarations, not `engines.dsh`, and are not a sandbox against malicious package code.」
- **② 响亮程度：不响亮**（同上：不匹配的 bundle 被 skip 并列入 `skippedBundles`，启动照常）。
- **③ 检测点**：`scripts/profile-config-preflight.sh` 的「版本漂移」检查（同族 fixed 版本混装即红）+ lockfile 的 `minimumReleaseAgeExclude` 白名单（cohort 变更必须显式改文件，评审可见）。
- **判定**：**部分满足**（同 §C-1，缺的是「期望集合 vs 实际集合」的启动后断言）。

### A3 agent-presets registry（`@deepseek-ai/dsh-agent-preset-registry`）

- **依赖点**：`packages/base/src/presets.ts:14`（`inject = ['loader', 'agentPresets']`）、`packages/base/src/presets.ts:214`（`ctx.get('agentPresets')` 后调 `register()`）；`packages/base/cordis.patch.yml:249-252` 对官方行 `agent-preset-registry` 的整行覆盖（`default: master`）；六个市场包的 `assets/preset/<market>-trader/agent.cordis.yml`。
- **① 契约**：官方文档级承诺，且给了最小配置形态（README「Minimal configuration」给出 `agent-preset-registry` 行 + `config: { default: standard }`）。官方同时承诺失败可见：「Failed definitions remain visible, while existing Agents retain the composition they already use.」
- **② 响亮程度：中等。** 注册对象形状变了 → 我们本地声明的 `PresetRegistry` 结构面在**编译期**红（类型来自精钉版本的 devDep）；注册成功但 preset 内容坏了 → 官方保证 broken 行可见（不致命，也不静默）。
- **③ 检测点**：`packages/base/test/presets.test.ts`（角色 × 市场 × 技能白名单的组装断言）、`packages/base/test/role-skills.test.ts`；`pnpm patch-id:check` 的冻结清单覆盖 `agent-preset-registry` 覆盖行（有人删掉这行会红）。
- **判定**：**满足**（组装语义有断言；「注册后真的挂上了」由 P2 的 bot profile 端到端覆盖，见 §C-2）。

### A4 approval 缝（`ctx.on('tools/pre-execute')`）

- **依赖点**：`packages/base/src/index.ts:121`（统一闸门监听器）、`packages/base/src/index.ts:84`（拒绝文案）。
- **① 契约**：官方公开事件缝；返回 `{ kind: 'ask' }` 由宿主 approval 面裁决。官方语义（`serviceAsk`）：approval 服务缺失 / 无 agent / headless ⇒ 降级 deny（fail-closed）。
- **② 响亮程度：不响亮。** 事件名或返回形状变了，我们的监听器就变成「注册了但没人问」——闸门静默失效。dry-run 默认仍在，所以不会直接变实盘，但**人工审批这一层消失**。
- **③ 检测点**：`packages/base/test/gate.test.ts`（闸门监听器的三态与 fail-closed 断言）；设计文档 §5 已同时记录「闸门不删、只换应答者」，实盘授权另由 `@dshtrading/authority` 承载（不依赖 approval 缝）。
- **判定**：**满足**。

### A5 typert-protocol / api-gateway（宿主 RPC 网关）

- **依赖点**：`packages/client-ui-trading/src/tasks/service.ts:32`（惰性解析宿主 `typertGateway`）、`packages/client-ui-trading/src/tasks/runner.ts:115`（不可用时显式抛错）、`packages/client-ui-trading/src/tasks/runner.ts:85`（描述符表实证：`agentPresets/list` 无参必须传空对象）。
- **① 实现细节，不是契约。** 设计文档 §7.1 已裁决：官方 Typert Remote 只作 GUI profile 的**可选绑定**，移动端不吃这条 wire（信任栅栏是同源浏览器会话、不建立身份、无按设备撤销，且 wire 是内部协议，会把 App 发布节奏绑到 DSH cohort 上）。
- **② 响亮程度：响亮但局部。** 网关不可用 → runner 抛 `session gateway (typertGateway) is unavailable on this host`（使用者当轮就看到）；描述符形状变了 → 调用报错。
- **③ 检测点**：runner 的显式错误路径 + `packages/client-ui-trading/test/` 的 tasks 服务用例。
- **判定**：**部分满足**。「描述符表实证」（无参必须传空对象这类）目前只活在注释里，没有断言把宿主 RPC 的形状钉住；缺口见 §C-3。这不是新债——它是「实现细节」缝的固有成本，所以设计上把它限制在**可选的 GUI 绑定**里，bot 关键路径不经过它。

### A6 loader patch 语义（insert / 整行替换 / `!!js` / `[]` 空层）

- **依赖点**：全部 9 个 `cordis.patch.yml`；`packages/base/cordis.patch.yml` 的两处 `disabled: !!js (...)`。；`packages/all/cordis.patch.yml` 的空层写法。
- **① 契约**：官方文档级承诺。README：「replace one entry's whole config (restating the fields you keep), insert new entries, or interpolate `!!js` expressions at boot. A patch naming an entry that does not exist prints a stderr warning; **an empty or comments-only file fails boot — disable the layer with `[]` instead**.」
- **② 响亮程度：不响亮，且已实测。** `cordis-plugin-loader@1.0.5` 的 `Include.update` 对重复 id 用 `Object.fromEntries` 建表 ⇒ **重复 id 静默塌缩为最后一条**，既不抛错也不告警（旧注释里记的「duplicate loader entry id」在本 cohort 不成立）。这一条是 2026-10-01 行 id 门禁的直接动因。
- **③ 检测点**：`pnpm patch-id:check`——R1 唯一性（多层/同层重复 insert 即红）、R2 命名空间（市场行只归市场层，共享行归 base）、R3 只增不改（市场 bundle 禁止整行替换）、R4 冻结清单（`scripts/patch-id-freeze.json`：新行 id / 改名 / 换 owner / 消失都要显式 `--update`）、R5 层可达性。自测 23 例，逐条证明规则「真的会红」。
- **判定**：**满足**。

### A7 storage backend registry / `ctx.storageDomain`

- **依赖点**：**无**。全仓 `packages/<pkg>/src` 对 `ctx.storage` / `storageDomain` / `storage.backend` 零引用。
- **① 契约**：官方确实提供 registry 缝，但设计文档 §4「A2 证伪」已记录：rc.2 只发货 `dsh-storage` / `dsh-storage-domain` / `dsh-storage-json`，**没有 SQLite backend**（README 推荐的 `storage-sqlite` 未发布）；即便有，订单/成交面也不放 `storageDomain`（无事务、内存权威、`domain/changed` 不是事务参与者、无回放语义）。
- **② 响亮程度**：不适用（不用它就不会因它变更而失败）。
- **③ 检测点**：**「不用」本身就是可检测的事实**——本清单记录零引用，且 §D 的复核节奏要求换 cohort 时重跑这条 grep。若将来要引（自研 backend 走 `ctx.storage.backend.register()`），必须先过三问并把检测点写进本文件。
- **判定**：**满足**（依赖的是「不依赖」）。

---

## B. 已排除项（我们依赖的是「不依赖」，同样要能看见「其实依赖了」）

### B1 官方 `dsh-schedule`

- **① 实现细节 + experimental**：它绑定 `sessionId`（desk 会话换代即失联），依赖 `dsh-api-session-controller` → peer `dsh-client-connection`，与「bot 不踩 web 栈」冲突；且不在已发布 profile 的 bundles 列表里。
- **②③ 检测点**：仓库内零引用（`grep -rn "dsh-schedule" packages/<pkg>/src packages/<pkg>/cordis.patch.yml` 为空），profile bundles 白名单见 §C-4。**判定：部分满足**（白名单断言尚未落地）。

### B2 官方 `dsh-webhook`

- **①**：唯一运行时动作是**新建 root Session**，唤不醒既有 desk 会话；自称无队列/重放/重试/去重。
- **②③**：同上（零引用）。**判定：部分满足**（同 §C-4）。

### B3 web 栈信任栅栏（`webserver` / `connection` / `modules`）

- **① 契约（且是宿主常量）**：`connection` 的信任栅栏是浏览器语义（tokenized URL + 签名 cookie + Host/Origin 校验）；官方全局必需集是 `agent-loop, webserver, modules, connection, headless-runner, acp, sdk-jsonrpc-server`，**在场且失败会让整个 app dispose 退出**。
- **② 响亮程度：响亮（启动即崩）**——这正是「bot 不踩 web 栈」的技术理由。
- **③ 检测点**：`packages/base/cordis.patch.yml` 的两处 `disabled: !!js (...)`。条件禁用（headless 宿主缺服务时按提供方行禁用，issue #88 实测）；`pnpm build` + `pnpm -r test` 覆盖 headless 组合的装配。
- **判定**：**满足**。

### B4 experimental bundle

- **①**：experimental bundle 不在已发布 profile 的 bundles 列表里，语义与存活期都不承诺。
- **②③ 检测点**：见 §C-4 的 bundles 白名单缺口。
- **判定**：**部分满足**。

### B5 未发货的 SQLite backend

- **①**：不存在的东西不能依赖。设计文档 §4 已证伪「`ctx.storageDomain` + SQLite 组合即可」。
- **②③**：同 A7（零引用 + 换 cohort 时重跑 grep）。**判定：满足**。

### B6 `agent` / `agent-loop` 的公开 API（**未来依赖，当前未使用**）

- **① 契约**：官方公开 API（`ctx.agents.get(id).followup()`、profile 声明 `agent-loop` 的 `agents: [{ id, sessionId }]`）。设计文档 §6 的 U9 实测已确认：在 `dsh-base` + `dsh-headless` 组合里可物化，且对已存在 `sessionId` 是**恢复历史而非新建空会话**。
- **② 响亮程度：未知（尚无调用方）。** 这是 P3 才落地的缝，本清单提前登记，避免 P3 时以「显然没问题」结案。
- **③ 检测点：未满足。** P3 落地时必须同批交付三条断言：profile 声明可物化的启动断言；`followup()` 恢复历史而非新建空会话的断言（U9 实测的复现）；扇出节流的不变量断言（设计文档 §13.20）。见 §C-5。
- **判定**：**未满足**（登记在案；当前零引用，不阻塞 P0/P1/P2）。

---

## C. 缺口清单（判定为「未满足 / 部分满足」的未闭合项）

| # | 缺口 | 为什么现在的检测点不够 | 建议检测点 | 成本 | 挂到 |
|---|---|---|---|---|---|
| C-1 | 期望 bundle 集合 vs 实际加载集合 | 官方只在启动日志打一次 `skippedBundles`；日志不是门禁——少挂一个市场 bundle 与「正常启动」在进程退出码上不可区分 | 启动后审计：把 profile 期望的 bundle 集合与宿主实际加载的集合求差，非空即红（bot 的 startup provider 行天然有这个位置） | S | P2 |
| C-2 | preset 注册的端到端可见性 | `presets.test.ts` 只钉组装语义，不钉「注册后真的能挂进会话」 | bot profile 起来后断言 `agentPresets/list` 含全部期望 preset 且无 broken 行 | S | P2 |
| C-3 | 宿主 RPC 描述符表（typertGateway） | 「无参必须传空对象」这类形状实证只活在注释里 | 对 `agentPresets/list`、`session/list` 的形状断言（可用 `--dump-config` 或宿主 RPC 的离线契约测试） | M | P4 |
| C-4 | profile bundles 白名单 | 仓库里没有任何断言阻止有人往 bundles 里塞 experimental / web 栈 bundle | CI 断言：仓库内 profile bundles 列表 ⊆ 白名单（`dsh-base` / `dsh-web-app` + `@dshtrading/*`），白名单外一律红 | S | P1（拆包时 bundles 会大改，同批做） |
| C-5 | agent/agent-loop 缝的启动与扇出断言 | 该缝当前零引用，P3 才落地 | 见 B6 的三条断言 | M | P3 |

**登记规则**：任何新增官方缝依赖，先在本文件补一条 A 节条目（含三问与检测点），再写代码；缺检测点即视为未满足，不允许以「已评估」结案。

---

## D. 复核节奏

1. **换 DSH cohort**（`dsh-sdk-upgrade` 流程）时：逐条重跑 A/B 节的检测点命令，更新「官方版本锚」，并在 §C 里增删缺口。
2. **每次新增 `@deepseek-ai/*` 依赖或新 profile 行**：同一变更内更新本文件；`pnpm patch-id:check` 会强制新行 id 显式登记（§A6）。
3. **本文件与设计文档的分工**：设计文档 §10 写「能不能踩」的结论，本文件写「踩了以后怎么知道它断了」。两者一起改，不允许只改一边。
