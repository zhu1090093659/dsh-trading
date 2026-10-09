# Agent Note: 刷新入口泛化为 refresh-profile.sh，任意 profile 一条命令

Status: implemented

## Problem

profile 的 `@dshtrading/*` 是 `file:` 安装快照，改完源码必须重建副本。此前刷新入口
`scripts/refresh-trading-web-profile.sh` 把目标硬编码为 `trading-web`：
`trading-all` / `trading-dev` 的刷新只能照
[profile-cohort-normalize-preflight-gate](2026-09-04-profile-cohort-normalize-preflight-gate.md)
手工复刻四步（同步 overrides → 删副本 → `dsh plugin install` → 重挂核心包 symlink）。

2026-10-09 实测这条路径的两个漏点：

1. **重挂 symlink 是易漏的人手步骤**：`pnpm install` 会重新物化 `@deepseek-ai/*`
   影子拷贝，不重挂就留下双模块实例（工具调用在模块级 Symbol 上崩，`reading 'prepare'`）。
   脚本把它当第二步，但手工复刻时没人拦着漏做。
2. **trading-all 的既有漂移会带病 install**：刷新前预检报闭包缺口（overrides 缺
   authority / bot-api / client-ui-bot-gui / gui）与版本漂移（`@dshtrading/*`
   0.4.1 ×40 / 0.5.0 ×10）；而版本漂移恰恰是紧接着的「删副本 + 重装」必然消除的东西。

## Decision

1. **新增 `scripts/refresh-profile.sh`**，对任意/多个 profile 执行同一套四步，
   按 profile 依次：同步 overrides（`sync-profile-overrides.mjs`，幂等追加）→
   预检 → 停该 profile 运行中实例 → 删包副本 → `dsh plugin install` →
   **无条件重挂宿主核心包 symlink**。重挂从「人必须记得的第二步」变成脚本的一部分。
   - 用法：`refresh-profile.sh [--profile <p>]... [--package <pkg>]... [--dsh-home <dir>] [--host-root <dir>]`；
     位置参数是 profile 名，缺省 `trading-web`；`--package` 只刷指定 `@dshtrading` 包。
   - 逐个核对目标 profile 存在后才动手；`DSH_HOME` 指向宿主 home 时拒绝执行（沿用既有守卫）。
   - 停实例时排除刷新器自身进程：泛化后脚本命令行里就可能含 `--profile <p>`，
     裸 `pgrep -f "profile <p>"` 会匹配到自己并自杀。
2. **旧入口保留为转发 shim**：`scripts/refresh-trading-web-profile.sh [pkg ...]`
   把位置参数翻译成 `--package`，目标固定 `trading-web`，语义不变；外部技能
   （`~/.agents/skills/dsh-sdk-upgrade`）与既有习惯继续可用。
3. **预检新增 `--allow-version-drift`**：刷新位对检查 ④（版本漂移）只告警，
   其余三类（死路径/身份漂移/闭包缺口）仍中止；默认模式（不带该 flag）版本漂移仍是
   硬失败，启动失败排查照旧按 `exit 1` 读。
4. **`scripts/refresh-profile.test.mjs`**（进 `test:scripts`）覆盖：漂移在默认模式
   判红、带 flag 降级放行、闭包缺口在两种模式下都中止、`--help`/`--bogus`/未知
   profile/宿主 home 守卫，以及泛化入口与 shim 各自真的刷新到目标 profile。
   测试全部只碰 `mkdtemp` 夹具 home（名字含 `-trading` 才过守卫）并把 `dsh`
   换成 PATH 上的假实现——测试绝不对 `~/.dsh-trading` 做插件安装。

## Verification

- `pnpm test:scripts`：15 文件 / 116 用例全绿（新增 10 例）。
- `pnpm test:audit`：通过（无新增测试债）；`docs-link:check`、`i18n:check`、
  `repo-boundary:check`、`ci-wiring:check`、`home-guard:check` 全绿。
- 真机演练（无实例运行，owner 已停）：`./scripts/refresh-profile.sh trading-web trading-all`
  一次刷新两个 profile，两者 `@dshtrading/*` 全 0.5.0、核心包 un-normalized 拷贝 0、
  `connector-futu/lib/rest.js` 均含 `/api/trd/get-orders` ×2 与 POST 形态，
  收尾预检两者 OK。

## Alternatives considered

- **只把硬编码目标参数化，symlink 重挂仍留给人**：正是本 note 要消除的漏点——
  漏做即静默双实例崩溃，不采纳。
- **为 trading-all/trading-dev 各写一个脚本**：三份近乎相同的逻辑要同步维护
  （CORE_PKGS 清单已改过多次），泛化成一个入口更省。
- **让预检在刷新位彻底跳过版本漂移检查**：会在非刷新场景漏掉真漂移告警，
  降级为警告而非删除更准确。

## Consequences

- 刷新任意 trading profile 的命令统一为 `scripts/refresh-profile.sh <profile...>`；
  `AGENTS.md`、`docs/ops/running.md`、`README.md` 的入口事实同步更新。
- 手工复刻四步的做法不再需要；本 note 与
  [profile-shadow-copy-prepare-crash](../bug-fix/2026-09-01-profile-shadow-copy-prepare-crash.md)、
  [profile-cohort-normalize-preflight-gate](2026-09-04-profile-cohort-normalize-preflight-gate.md)
  的事实已原地更新（那两个 note 仍是 symlink 归一与预检四类漂移的 Owning Note）。
- 未改：本脚本仍不处理 `trading-bot` profile（其 `file:` 依赖指向已迁往卫星仓的
  `packages/bot`，刷新必须改走卫星仓，见 `docs/ops/running.md`）。
