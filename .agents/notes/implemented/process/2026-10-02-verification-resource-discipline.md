# Agent Note: 验收与重活执行的资源纪律

Status: implemented

## Problem

2026-10-02 的一次验收把验收拆成 5 个并发 subagent，且与 `pnpm gates:all`（build + `-r test` + 覆盖率 + 370 秒 typecheck）同时运行，造成：

- 主机 load(15m) 冲到 20+、swap 用到 4.4 GB（已影响用户交互）；
- 两台孤儿进程残留：6 个 `pnpm -r test` 的 vitest worker（父进程退出后 ppid=1）与 1 个真 Electron（附着演练 `desktop/scripts/attach-electron-drill.mjs` 的 `finally` 只杀 `.bin/electron` 包装）。前者自行退出，后者需手工清理。

同期还暴露两条验收口径问题：并发会话在验收窗口内持续改动工作区（10 分钟内未提交项 7 → 20），使"工作区干净/N 例全绿"这类台账数字当场失效；`coverage:check` 在某个包收集失败时会静默把该包移出聚合、再按"无指标下降"判通过（已于同日修复：无报告即红，见 [测试与 CI 棘轮](../testing/2026-09-15-test-hygiene-ratchet-and-tiered-ci.md) 的「门禁可信度三修」）。

## Decision

在 [AGENTS.md](../../../../AGENTS.md) 增加「验收与重活执行的资源纪律」一节，五条契约：重活串行；跑完必查孤儿（给出命令）；drill/长驻脚本按进程组回收；验收结论必须绑 commit 并现场复跑；退出码不等于通过（须读输出里的 `[无报告]`/FAIL 行）。

## Alternatives considered

- **只写在验收报告里**：报告在 `.local/`（gitignored），下一个会话看不到，等于没写。败。
- **靠"注意并发"的口头约束**：这与本仓「可机检的约束不留给纪律」相反；本次已给可复制粘贴的孤儿检查命令。败。
- **给 `pnpm gates:all` 加并发锁**：属工具改造，超出本次范围；先立契约，若再次踩到再机械化。

## Consequences

- 验收/审计类任务不再并发跑重活；subagent 数量与重活数量解耦（静态核对可并行，动态命令串行）。
- `attach-electron-drill.mjs` 的孤儿缺陷已修：Electron 以 `detached` 起（`setsid` ⇒ 自成进程组），`finally` 里 `kill(-pid)` 回收整组并等组清空，残留即判 FAIL；"没有派生本地 host"的断言限定在**自身进程树**（进程组 + ppid 链），不再全机 `ps` grep `--profile trading-web` —— 机器上任何既存 trading-web 实例都会让旧断言假红。
- 台账数字不再被当作验收证据；验收报告必须写明 HEAD sha 与复跑命令。
