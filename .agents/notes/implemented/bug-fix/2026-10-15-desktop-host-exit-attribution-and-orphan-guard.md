# Agent Note: 桌面壳宿主退出的归因与孤儿宿主守卫

Status: implemented

## Problem

2026-10-15 用户报「The dsh host could not start / 后台服务进程意外停止」并提供错误页日志，日志尾部是：

```
[desktop] GUI ready, loading the tokenized URL
[renderer] warning … [connection] connection lost, retry #1
[desktop] host exited: code=0 signal=null (后台服务进程意外停止。)
```

两条实测事实把这次排查逼进死角：

1. **那行 `host exited: code=0 signal=null` 不是故障证据。** 壳自己退出时也打完全相同的两行（`stopHost` → 进程组 SIGTERM → `@deepseek-ai/dsh` 的 profile-boot 把 SIGTERM 映射成优雅退出 → `process.exit(0)`，所以 signal 是 null）：同一份日志里 16 段运行全部以这行收尾，正常关应用的实测复现与用户贴的尾部逐字相同。真正区分「壳在退出」与「宿主自己停了」的只有错误页——它由 `!quitting` 守卫。
2. **宿主静默 code=0 的退法有三种，日志上无法区分**：profile-boot 的 SIGTERM 优雅退出、插件经 cmdline `appExit(0)`、以及树被 dispose 后事件循环排空。而插件树崩溃不是这个形状：`installFailLoud` 必写一行 stderr 诊断并以 `process.exit(1)` 结束。用户日志里既无诊断也无 code=1，所以那是「被要求停止」，但没人能说出是谁要求的。

同期还实测到第二个缺陷：**壳非正常死亡会留下孤儿宿主**。宿主以 `detached` 派生、只在 `before-quit` 里被 `stopHost` 停，SIGTERM/SIGKILL 打到**应用**（`pkill`、活动监视器退出、注销）时 `before-quit` 根本不跑。本次排查中两次 `pkill -f "DSH Trading.app/Contents/MacOS"` 就留下两个 `ppid=1` 的宿主（62194、64947），各自继续占着 loopback 端口与 `trading-tasks/ledger-v1.json.lock`；下一次启动只能打 `[dsh-trading/tasks] task ledger unavailable` 而不是拥有这个 home。

## Decision

两个宿主侧钩子随 `--import` 注入（与既有 `host-symbol-normalizer.mjs` 同一通道、同一 `asarUnpack` 机制），外加一行可归因的退出日志：

- **`desktop/src/host-exit-tracer.mjs`（只观测，不改生命周期）**：包装 `process.exit` 记录调用方栈，监听 `beforeExit` 记录「事件循环排空、无人请求退出」。三者合起来把静默 code=0 三分：SIGTERM → `exit(0) requested` 且栈穿过 profile-boot 的 `forceExit`/`forceExitOnce`；`appExit(0)` 或树被 dispose → 只有 `event loop drained`；stderr 只有这两者之外的表现即为其他路径。**刻意不加任何信号监听**：加了就等于替换该信号的 Node 默认终止动作，会改变这个钩子本要描述的生命周期语义（SIGKILL/SIGHUP 这类原始信号死亡，壳自己的 `host exited: signal=…` 已经记录）。
- **`desktop/src/host-orphan-guard.mjs`（行为）**：只看壳在 `DSH_DESKTOP_SHELL_PID` 里宣告的 launcher pid，两个读数任一成立即判定壳已消失——该 pid 不再应答 `kill(pid, 0)`，或宿主已被 reparent 到 launchd（`process.ppid === 1`，同时覆盖 pid 探针会把未收尸僵尸报成活的边界）。判定成立后先给自己发 SIGTERM 走 profile-boot 的既有优雅退出，5 秒内没退出则 `process.exit(0)` 强制收尾。采样走 `unref()` 的 2 秒区间，守卫绝不延长它要终结的生命周期；没有该环境变量的宿主（开发直跑、测试）完全不武装，钩子在壳未派生它的进程里是惰性的。
- **`formatHostExitLine`（runtime.cjs，纯函数）**：退出日志在原有 `code=/signal=` 之后加 `initiatedBy=shell|host` 与 `after=<ms>`。`initiatedBy` 就是 `quitting`——壳自己停的写 shell，其余写 host，两者不再共用同一个读法。宿主侧 `[host-lifecycle]` 行与它同落 `dsh-host.log`（宿主 stderr 一直被壳收进日志），错误页展示的仍是这段尾部。
- **非壳发起的退出不再把应用钉死在报错页（`planHostRecovery` + `recoverHost`）**：宿主停掉而壳没要求时，壳原地重启宿主并先在那张页上写明「正在自动重启（第 k 次）」，成功后加载新宿主的 tokenized URL。预算有界：10 分钟内最多 3 次自动重启（`HOST_RECOVERY_MAX` / `HOST_RECOVERY_WINDOW_MS`），第 4 次落到报错页并保留日志——崩溃循环仍然以人可以读的现场结束，而不是无限重启。错误页的「重试」是人工决定，同时把预算清零。`boot()` 因此有了重入闸（`booting`），否则重试与自动恢复会同时派生两个宿主。

安装位取效路径不变：改动只落在 `desktop/src/*` 与 `electron-builder.yml`，按 [本地重建 note](../process/2026-09-11-desktop-shell-local-rebuild-open-env-pitfall.md) 的 app.asar 单档替换路径生效，两个新钩子必须同时出现在 `app.asar.unpacked/src/`（`asarUnpack` 已列，`desktop/tests/host-symbol-normalizer.test.mjs` 的打包断言已扩到三个钩子）。

## Verification

- **孤儿守卫 A/B（真宿主、真 home，2026-10-15）**：一个壳替身按 `main.cjs` 的方式派生宿主（同 hooks/同 env/`detached`），stdout+stderr 落文件（管道会随父进程关闭，证据会丢），12 秒后 `SIGKILL` 自己。处理组（注入钩子）日志：`[host-lifecycle] orphan guard: launcher pid … is gone; requesting shutdown` → `exit(0) requested`，栈为 `exitStack → process.exit → forceExit (profile-boot-BZ2ZjNWi.js:22) → forceExitOnce (:38)` → `process exiting code=0`，宿主进程消失；对照组（当日壳的派生方式，无钩子）宿主在父进程死后仍存活，需手工清理。对照组存活同时解释了处理组日志里那条 `task ledger unavailable (locked by another live host process)`——正是孤儿宿主的现实危害。
- **桌面测试 60/60**（`pnpm test:desktop`）：新增 `desktop/tests/host-lifecycle.test.mjs` 13 例（钩子决策、注入函数缝、真实 Node 子进程的 `--import` 装载与退出形状、未派生进程惰性），`runtime.test.mjs` 补 `formatHostExitLine` 两种形状与 `asarUnpackedPath`（含 Windows 分隔符与已解开路径幂等）。
- **门禁**：`pnpm test:audit` 通过（无新增测试债，标题按角色前缀、正文 Given/When/Then）、`pnpm docs-link:check`、`pnpm repo-boundary:check` 见本 Note 同批提交结论。
- **诊断读法（下次直接照此判定）**：`grep '\[host-lifecycle\]' ~/Library/Logs/dsh-trading-desktop/dsh-host.log`；`initiatedBy=shell` = 壳在退出（正常）；`initiatedBy=host` + `exit(N) requested` 且栈含 profile-boot = 被信号要求停止；只有 `event loop drained` = 插件请求退出或树被 dispose。
- **原始症状复现 + 归因（装后，真安装位）**：对跑着的安装版宿主直接 `kill -TERM`（外壳仍存活），错误页原样出现（`The dsh host could not start / 后台服务启动失败` + `后台服务进程意外停止。`，即用户贴的那一屏），日志尾部为 `exit(0) requested`，栈穿过 `forceExit → forceExitOnce (profile-boot-BZ2ZjNWi.js:22/:38)`，末行 `host exited: code=0 signal=null initiatedBy=host after=69251ms`。这就是原排查拿不到的那半张图：同一形状此前与正常关应用逐字相同，现在 `initiatedBy=host` + profile-boot 关机控制器栈 = **外部要求宿主停止**（SIGTERM 的优雅路径；若是守卫所为，同一份日志里还会有它自己的 `orphan guard:` 行；若是插件请求退出或树被 dispose，则只有 `event loop drained`）。**仍未确定的是发送者**：Node 侧看不到信号来源，本机全部会话记录里也没有相应用户态 `kill`（唯一一次 `pkill` 是 21:15 清 updater stub），所以这条只到「外部信号」为止，不到「谁发的」。
- **文件后端 A/B（装后，用安装位的三个钩子，2026-10-15）**：壳替身派生两个宿主——处理组注入 `app.asar.unpacked/src/` 的钩子，对照组不带钩子，两者 stdout/stderr 都落文件（管道会随父进程关闭，硬杀场景下证据会丢），父进程随后 `SIGKILL` 自己。处理组 stderr 逐步记下 `tracer attached` → `orphan guard: launcher pid … is gone; requesting shutdown` → `exit(0) requested`（同一 profile-boot 栈）→ `process exiting code=0`，宿主消失；对照组零条 `host-lifecycle` 且宿主存活（同时排除「断管把它写死」：同样的断管，对照组没死）。
- **清理**：A/B 探针脚本、日志、探针宿主与两个诊断期孤儿宿主（62194、64947）已全部回收；安装位最新一档 `app.asar` 为 `a32e770b…`（换档前后各次都做了 extract 读回比对，两文件与工作区逐字节一致），回滚档仍为 `/tmp/dsh-appasar-backup-b567bd15.asar`。
- **自动恢复实测（装后，真安装位，2026-10-15）**：对跑着的宿主连发四次 `kill -TERM`（每次都等它恢复）。第 1/2/3 次分别打 `restarting the host (attempt 1|2|3/3 within 10min)` 并各自起新宿主、重新加载 GUI（窗口截图实测交易界面回来了，自选/K线/对话面板在），应用进程始终存活；第 4 次打 `host restart budget spent; leaving the startup-problem page up (Retry resets it)` 且不再派生宿主——有界恢复按设计收口。
- **自动恢复验收过程中自查并修掉的两个缺陷（都在同一次交付内）**：① `tokenUrl` 是模块级变量，恢复/重试会读到**上一个宿主**的 URL，于是 `waitForTokenUrl` 立刻返回旧 URL、壳去加载一个没人服务的端口——日志表现为恢复已成功（新宿主在服务、GUI 已 ready）却打 `host restart failed: ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:50833/?token=…'`（50833 是刚死的那个）。改为 `createTokenUrlCollector()` 的 per-boot 收集器，`bootOnce` 先 `reset()`，该不变量有了单测。② 上一页对死端口的重试失败会被 Electron 记在当前 webContents 上，从而reject 新一次的 `loadURL`；`isNavigationFailureFor(message, target)` 只把与本次目标相符的失败当真，其余记为 `ignored a navigation failure from a previous host`。
- **未做成的验证（如实记录）**：报错页「重试」按钮的点击验证没做成——AX `press` 与像素点击都返回 `effect:"unverifiable"` 且页面无变化（web 内容对合成点击的既有边界）。预算清零是代码级一行（`unexpectedExitTimes = []`），恢复路径本身已由上面的 `kill -TERM` 序列实测覆盖，但「点按钮能复位」没有点击证据。
- **原始症状仍然只到「外部要求宿主停止」这一层**：发送者未定位——今天的会话记录里没有任何会话执行过 `pkill`/`killall`/裸 `kill <pid>`/`process.kill(`（唯一一次 `pkill` 是 21:15 清 updater stub），profile 内也没有任何插件调用 `appExit`/`process.exit`，二次启动被单实例锁吸收、profile patch 变更与同 home 第二宿主都不杀宿主。缺口在发送侧，Node 看不到信号来源。


## Alternatives considered

- **只加诊断、不碰生命周期**：能回答「谁停的」但把已知缺陷留着——孤儿宿主仍会占端口与 ledger 锁，且下一次启动仍报 ledger unavailable，拒绝。
- **给宿主加信号监听以记录 SIGTERM**：观测收益与现有栈证据重叠（SIGTERM 的栈已穿过 profile-boot），代价却是把该信号的默认终止动作换掉，等于让「被 kill 的宿主」变成「不死的宿主」，拒绝。
- **把孤儿守卫做成壳侧的东西（crash reporter / 守护进程 / launchd）**：壳已经死了，壳侧无执行者；而宿主的父进程死亡是它自己能观测到的最直接事实，拒绝。
- **用 stdin EOF 绑生命周期（壳持住写端，宿主读到 end 即退出）**：事件驱动、零轮询，但需要 `process.stdin.resume()`，会从宿主侧吃掉 stdin；`@deepseek-ai/dsh-cmdline` 只在 acp/sdk app 里绑 stdin，web 宿主这份输入留给将来的 stdio 协议面，拒绝（改用 pid + ppid 双读数）。
- **只在 `ppid === 1` 时判定**：Windows 不 reparent（ppid 仍指向死进程），且 pid 复用会让 `kill(pid,0)` 假活；两个读数任一成立更稳，拒绝单读数。

## Consequences

- 退出日志的读法变了：`initiatedBy=shell|host` 与 `after=<ms>` 是新的事实来源；`code=0 signal=null` 单独出现不再说明任何事。历史 `dsh-host.log` 里此前的行没有这两个字段，按旧形状读会误判，故本 Note 给出三种形状的对照。
- 宿主现在有一条「父进程死亡」的自主退出路径（`[host-lifecycle] orphan guard: …`），它的退出码是 0、栈穿过 profile-boot，与壳的 teardown 在宿主侧不可区分——区分靠壳行的 `initiatedBy`，这正是新增字段的用途。
- 壳替身/演练脚本派生宿主时必须显式带 `DSH_DESKTOP_SHELL_PID`，否则钩子惰性（这正是设计意图：非壳派生的宿主保持自己的生命周期）。
- 相关事实归属：壳的交接设计与进程组 teardown 仍以 [Electron 桌面版 note](../architecture/2026-09-03-electron-desktop-app.md) 为准，本文只拥有「退出归因」与「孤儿守卫」两项。
