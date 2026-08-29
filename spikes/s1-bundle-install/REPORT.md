# S1 REPORT：树外 bundle 组合包安装进 scratch profile 并生效

- 结论：**PASS**（机制全链路验证通过；0 次模型调用，无 e2e 凭证依赖）
- Profile：`spike-s1`（scratch，专用）｜ 时间：2026-08-29 15:00–15:08 CST
- 工作目录：`/Users/zcl/code/dsh-trading/spikes/s1-bundle-install/`

## 结论

| 通过标准 | 结果 | 证据 |
|---|---|---|
| bundle patch 在 scratch profile 生效 | ✅ | dump 组合树出现 bundle 层与 insert 行（artifacts/11、15） |
| 插件加载 | ✅ | boot 日志 `[S1-MARKER] hello-plugin ACTIVATED`，SIGTERM 干净退出 0（artifacts/12、18） |
| 可卸载 | ✅ | remove 后依赖/bundles 列表/node_modules 三处同步清除（artifacts/13） |
| 双 bundle insert-only 无冲突 | ✅ | 两个不同 id 行共存，同插件双挂载各打一次 marker，退出 0（artifacts/15、18） |

## 关键证据

1. **上次中断轮已证明 patch 语义生效**（artifacts/05-09）：`dsh plugin add` 后 `dsh.profile.bundles` 自动追加 `@spike-s1/hello-bundle`；dump 出现 `# == @spike-s1/hello-bundle` 层 + `- id: spike-s1-hello` 行；boot 先打出 `ACTIVATED` 再被 home 级 exa 悬空符号链接拖崩（`Cannot find package '@deepseek-ai/dsh-web-search-exa'`，exit 1）。
2. **exa 修复走官方命令**：`dsh plugin --profile spike-s1 add 'link:/Users/zcl/code/deepseek-harness/packages/web/web-search-exa'` → 装为普通依赖并打出预期警告（artifacts/10）：
   `dsh: warning: @deepseek-ai/dsh-web-search-exa declares no dsh.bundle — installed as a plain dependency, not a profile layer`
   bundle 列表保持 `[@deepseek-ai/dsh-base, @spike-s1/hello-bundle]` 不变。
3. **修后 boot 通过**（artifacts/12）：
   ```
   [S1-MARKER] hello-plugin ACTIVATED at 2026-08-29T07:02:58.838Z
   boot-exit=0   （SIGTERM → interrupt(0)，无任何错误输出）
   ```
4. **干净卸载**（artifacts/13）：`dsh plugin remove '@spike-s1/hello-bundle'` → package.json 依赖消失、bundles 回落到 `[dsh-base]`、`node_modules/@spike-s1/` 清空；exa 普通依赖不受影响。
5. **双 bundle 并存**（artifacts/14-18）：`add file:…/hello-bundle file:…/hello-bundle-2` → bundles `[dsh-base, hello-bundle, hello-bundle-2]`；dump 出现两个独立层与两行：
   ```
   # == @spike-s1/hello-bundle
   - id: spike-s1-hello
   # == @spike-s1/hello-bundle-2
   - id: spike-s1-hello-2
   ```
   boot 打出**两行** `ACTIVATED`（同一插件包被两个 entry 各挂载一次），exit 0，无冲突无报错。

## 机制细节（读 `apps/cli/src/plugin.ts` + `profile-boot.ts`）

- **识别**：`dsh plugin` 是 pnpm 薄转发器——在 profile 目录跑 `pnpm <args>`，成功后按**已安装状态**对账：依赖包 manifest 含 `dsh.bundle.patch` 即加入 `dsh.profile.bundles` 层栈（追加，序 = 依赖序），无声明则保持普通依赖并警告一次；remove 后按同规则移出。模板 bundle（dsh-base）非依赖、永不触碰。
- **分层**（应用序）：bundle 层（按 bundles 列表序）→ profile 自身 `cordis.patch.yml` → **home 级 `$DSH_HOME/cordis.patch.yml`** → `--patch` overlay → telemetry 开关。行组合按 `rows.set(row.id, row)`——**同 id 后层整行替换前层**，这正是「市场 bundle 只准 insert 新 id」铁律的机制根源。
- **profile 即 pnpm 包**：`~/.dsh/profiles/spike-s1/{package.json,pnpm-workspace.yaml,node_modules}`，nodeLinker hoisted。
- **boot**：空根 `cordis.yml` + 上述 patch 栈挂树；`patchReload: live` 时对 profile 层与 home 层装 HMR watcher，用户层编辑可热重载。

## 发现的坑

1. **home 级 `~/.dsh/cordis.patch.yml` 对所有 profile 生效且强于 bundle 层**：exa 行悬空即可炸掉任何新 profile 的启动（fail-loud）。且因 home 层在 bundle 层之后应用，bundle 里用同 id `disabled: true` 也压不住它——唯一解就是让包可解析（file:/link: 依赖）。官方实现建议：把机器本地行收敛进 per-profile 层或加「不可解析则跳过+警告」策略。
2. **裸路径 add = `link:` 语义，不装被链接包自身的依赖**：`add /abs/path/to/hello-bundle` → node_modules 只链 bundle 本体，其 `hello-plugin` 依赖缺失 → boot `ERR_MODULE_NOT_FOUND`（artifacts/16，AggregateError 两个 entry 同因失败）。显式 `file:` 前缀则连传递依赖一起装（首次成功即 `file:`，装 2 个包）。对官方 `add @dsh-trading/base`（registry 名）无影响，但**本地路径分发必须用 `file:`**。
3. **`file:` 是硬链接**：源文件与已装副本 inode 相同（实测 97728039）。用「重写文件」方式改源码会换 inode，已装副本变陈旧——改完包源码必须重跑 `pnpm install`（或用 `link:` 开发）。
4. `link:` 依赖指向 checkout 时，包自身的 node_modules 必须已在 checkout 内就绪（exa 就绪，故可用；spike-runner 同法）。
5. dump/日志会原样带出 home 层里的凭证（本报告已脱敏 artifacts 中的 mem0 token）；正式工具链应考虑 dump 脱敏。
6. 上轮 `file:` 硬链接在 remove 后被 pnpm 正常清理，无残留。

## 对正式实现的建议

1. **安装体验成立**：`dsh plugin --profile web add @dsh-trading/base @dsh-trading/crypto` 的 registry 形态与 spike 验证的 file: 形态走同一对账机制，分层与 insert-only 语义可直接承载市场 bundle 体系；市场 bundle 行 id 用 `trading-<market>-*` 命名空间即可零冲突并存（spike 已双 bundle 实证）。
2. **脚手架（S5）应固化**：bundle 包必须 `files` 带上 cordis.patch.yml、依赖里显式声明插件包；本地联调文档统一写 `file:` 绝对路径（或先 `pnpm pack` 再装 tarball），禁止裸路径。
3. **发布物用 npm registry 版本**而非本地路径，规避 `file:` 硬链接陈旧与 `link:` 依赖不安装两类坑。
4. 值得给上游提 issue/PR：(a) home 级 patch 悬空行应降级为警告；(b) `plugin add` 对裸本地路径默认 `file:` 或至少警告 `link:` 语义；(c) dump-config 脱敏选项。
5. spike 收尾：`spike-s1` profile 已装双 bundle 处于可用状态，S2/S3 可直接复用此 profile 或照抄其 package.json 结构。
