# Agent Note: 门禁脚本收敛——删除失效安装态分支、空开关与过宽扫描域

Status: implemented

## Problem

2026-10-03 自动交易平面迁往私有卫星仓后，主仓门禁脚本里留下五处「写了但没有作用」的代码：`gates-all` 的 `--with-installed` 追加已随平面迁走的 `pnpm bot-closure:check`（必然以「命令不存在」失败）；`--with-network` 只改提示文案；`ci-wiring-check` 的 bot-closure 豁免理由指向那个失效档；`docs-link-check` 把永久冻结的 `.agents/notes/archived` 也当活门禁对象（18 条基线里 5 条来自归档）；`home-guard-check` 有一张只有一条具名豁免的 `ALLOWED` 表。

## Decision

- `scripts/gates-all.mjs`：删 `INSTALLED_GATES`/`--with-installed`/`--with-network` 及其导入与文案；**未知参数显式 exit 2**（与 `--only` 选不中时的空洞成功守卫同一精神），默认档仍是 14 条。
- `scripts/ci-wiring-check.mjs`：bot-closure:check 的豁免理由改为「判据对象是 bot 安装闭包 ⇒ 已随自动交易平面迁往私有卫星仓（2026-10-03 拆分）」。
- `scripts/docs-link-check.mjs`：扫描域跳过 `archived` 目录（只缩域，不改判据、不碰冻结文件）；`scripts/docs-link-baseline.json` 随 `--update` 由 18 条降到 13 条。
- `scripts/home-guard-check.mjs`：删 `ALLOWED` 表与查找分支，保留注释过滤与 `home-guard-allow` marker。
- 自测同步：`scripts/gates-all.test.mjs` 增未知参数用例；`scripts/docs-link-check.test.mjs` 增「归档不参与活门禁、活树断链照拦」用例。

## Alternatives considered

- **保留 `--with-installed` 并在主仓装回 `bot-closure:check`**：判据对象已在卫星仓，重造跨仓脚本比删掉更贵，落选。
- **把 `archived` 断链加进基线**：基线记的是待修存量，归档永远不该修，记账等于永久假债，落选。
- **保留 `home-guard` 的 `ALLOWED` 作示例**：政策表只应列真实例外；该条目经 `violationsIn` 以非豁免路径实测返回空数组，确认冗余后删除。

## Consequences

- `pnpm test:scripts`：15 个文件 118 例全绿（含新增两条用例）。
- 行为证据：`node scripts/gates-all.mjs --with-installed` ⇒ exit 2 并点明未知参数；`--self-test` ⇒ exit 0；`--only=ci-wiring:check` ⇒ 只跑 1 条通过；`node scripts/docs-link-check.mjs` ⇒ 检查 287 个 markdown、基线 13 条、无新增断链；`node scripts/home-guard-check.mjs` ⇒ 644 个文件全绿。
- 卫星仓若仍引用 `gates:all --with-installed` 需要改（本记录不覆盖私有仓）。
