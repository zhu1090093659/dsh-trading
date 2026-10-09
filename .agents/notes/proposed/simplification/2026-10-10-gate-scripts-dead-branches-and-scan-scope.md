# Agent Note: 门禁脚本收敛——删除失效安装态分支、空开关与过宽扫描域

Status: proposed

## Problem

2026-10-03 自动交易平面迁往私有卫星仓之后，主仓门禁脚本里留下了五处「写了但没有作用」的代码。它们不改变任何判据，只让读输出的人多花一次核对。

1. 失效的安装态档：`scripts/gates-all.mjs:27-29,54-62,98` 的 `--with-installed` 会追加 `pnpm bot-closure:check`，而根 `package.json` 的 scripts 里已无该脚本（随平面迁走）。该档必然以「命令不存在」失败：红的原因不是门禁判据。
2. 空开关：`scripts/gates-all.mjs:26,108` 的 `--with-network` 只影响提示文案；同文件 `:51-52` 的注释已写明 `e2e:smoke` 迁走，GATES 清单不随该 flag 变化。
3. 指向失效档的豁免文案：`scripts/ci-wiring-check.mjs:103` 的 `bot-closure:check` 豁免理由仍写「已进 gates:all 的安装态档：pnpm gates:all --with-installed」，与第 1 条一起构成失效指引。
4. 过宽扫描域：`scripts/docs-link-check.mjs:32-40,42-46` 对 `.agents/**` 全递归，把永久冻结的 `archived/` 也当作活门禁对象。`scripts/docs-link-baseline.json` 的 18 条存量债里有 5 条来自 `archived/`（本机实测：过滤 `.agents/notes/archived/` 前缀得 5/18）。归档记录按仓库契约永久冻结，不得为过门禁去改它。
5. 冗余豁免表：`scripts/home-guard-check.mjs:37-41` 的 `ALLOWED` 只有一条具名豁免 `scripts/patch-id-gate.mjs`，而该文件里 `DSH_HOME` 只出现在注释（`:31`）；用脚本自身的 `violationsIn` 以非豁免路径跑全文，返回仍是空数组。

## Proposal

- 删 `gates-all.mjs` 的 `INSTALLED_GATES`、`withInstalled` 与 `--with-installed` 分支；删 `withNetwork` 及其唯一的文案用法；`:13-16` 的用法注释改到与实际 GATES 一致。同时让**未知 flag 显式失败（退出码 2）**，避免删掉开关后 `--with-installed` 被静默忽略、让人以为跑过安装态档——与 `:101-106` 现有的「空洞成功守卫」同一精神。
- `ci-wiring-check.mjs:103` 的豁免理由改为「随自动交易平面迁往私有卫星仓（2026-10-03 拆分）」，与同表其它条同款式。
- `docs-link-check.mjs` 的 `collect` 跳过 `archived` 目录（只缩扫描域，不改判据、不碰冻结文件）；`docs-link-baseline.json` 里 5 条 `archived/` 记账随之删除（18 减到 13）。
- 删 `home-guard-check.mjs` 的 `ALLOWED` 表与对应查找分支，保留通用的注释过滤与 `home-guard-allow` marker。

## Context & Efficiency Impact

- 消失的维护面：约 25-30 行失效分支、5 条永久僵尸基线、1 张一人豁免表，以及每次读门禁输出时的核对成本。
- 判据不变：`gates:all` 的 14 条、`ci-wiring` 的必须接线清单、`home-guard` 的违规判据全部保留；变的是不再给出误导性结果。

## Alternatives considered

- **保留 `--with-installed` 并在主仓装回 `bot-closure:check`**：判据对象（bot 安装闭包）已在卫星仓，主仓没有可判对象；重造跨仓脚本比删掉更贵。落选。
- **让 `--with-network` 真的追加网络门禁**：drill 全在卫星仓，主仓没有可跑对象；保留一个永不生效的开关比删掉更误导。落选。
- **把 `archived/` 的断链加进基线**：基线记的是「待修的存量新债」；归档冻结件永远不该修，记账等于永久的假债。落选。
- **保留 `home-guard` 的 `ALLOWED` 作示例**：政策表只应列真实例外，示例属于测试夹具。落选。

## Verification & Gates

- `pnpm gates:all`（14 条）绑 HEAD sha 现场复跑，重点确认 `ci-wiring:check`、`docs-link:check`、`home-guard:check` 仍绿。
- `pnpm test:scripts`：这几个脚本各有自测（`scripts/*.test.mjs`），改判据前后都要跑；与 `--with-installed` 相关的自测一并删除。
- 前后对比：`node scripts/docs-link-check.mjs` 的条目数应从 18 降到 13，且无新增断链；`node scripts/gates-all.mjs --with-installed` 改后应显式 exit 2。

## Risks

- 私有卫星仓若仍在引用主仓 `gates:all --with-installed`，删 flag 会让它的脚本失败；本记录不覆盖卫星仓，实现前须先在卫星仓 grep 一次。
- `docs-link` 跳过 `archived` 后，理论上有人可把新文档放进 `archived` 躲门禁；`archived/AGENTS.md` 的冻结契约与迁移流程是既有的反向约束，风险可接受。
