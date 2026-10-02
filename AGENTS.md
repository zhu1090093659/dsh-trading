# dsh-trading Agent 指南

DSH 交易插件 monorepo，按市场组织 bundle（crypto/us/cn/hk）。本文件只保留项目契约；通用执行、并发与授权纪律遵循用户级指令。

## 安全与当前授权

- bundle patch insert-only；知识进 skill 随包分发；base 拥有全部市场无关行；不内置密钥、不再分发数据。下单默认 dry-run，liveTrading 必须显式开启，base 统一审批闸门不得绕过。
- 修 CI、管线、配置或文档不授权发布。版本发布 bump、提交/推送、tag、npm 与 GitHub Release 按当前请求确认范围；历史授权、token 和启用的 workflow 不构成当前许可。发布入口：[dsh-trading-release](.agents/skills/dsh-trading-release/SKILL.md)。
- DSH 宿主安装与 SDK cohort 以当前实际安装及项目声明核验，不硬编码旧版本；宿主本体对本项目任务只读，不修改旧 deepseek-harness checkout。

## Home 与运行验证

- trading profile 和全部业务数据使用独立 home `~/.dsh-trading`；包内经 `@dshtrading/dsh-home` 解析。显式 `DSH_HOME` 可覆盖，但须核实目标是 trading 实例，不能因继承了 Web 会话环境而误用 `~/.dsh`。CLI 用 `~/.local/bin/dsh-trading` wrapper；桌面壳内置 trading 缺省 home。见 [home 契约](.agents/notes/implemented/process/2026-09-08-separate-dsh-home.md)。
- 本项目一律使用 `trading-web` profile：UI 验证是 `dsh-trading --profile trading-web`，无头用 `trading-dev`，全市场用 `trading-all`，不得挂回 Web 宿主默认 `web` profile。agent 会话继承的 `DSH_PROFILE`/`DSH_HOME`（如宿主自身 `desktop`/`~/.dsh`）属于宿主实例，不代表本项目 profile——启动、检查与验证一律按 `trading-web` + `~/.dsh-trading` 判。客户端更新后重建并按 [profile 刷新契约](.agents/notes/implemented/process/2026-08-29-trading-web-profile.md) 刷新 file: 副本；CLI/桌面切换注意 [cohort 链接方向](.agents/notes/implemented/bug-fix/2026-09-08-desktop-preset-context-injection.md)，CLI 刷新入口 `scripts/refresh-trading-web-profile.sh`。禁止实例运行中执行 plugin install，不擅自重启服务。
- UI 证据走宿主 tokenized HTTP URL + headless Chrome `--timeout` 截图，不做全屏桌面截图；按需加载 `ui-screenshot-verify`，见 [项目验证说明](.agents/notes/implemented/process/2026-09-04-ui-verification-hosted-http-headless-chrome.md)。宿主升级按需加载 `dsh-sdk-upgrade`，检查 profile shadow-copy/cohort；不要把裸 `dsh plugin install` 当刷新完成。

## 开发、分支与门禁

- 每次非平凡变更前先查阅历史决策，并在同一变更中记录或原地更新 [Agent Note](.agents/notes/README.md)。修改已有机制或跨包契约前，先搜索 `.agents/notes/implemented/` 审阅 Owning Note 的历史约束与被否决方案；若已有 Note 拥有该决策，就地更新其事实即满足要求，仅在无 Note 拥有时新建。交付态只写现在时事实，禁入规格腔（Proposal/Plan/Acceptance criteria）。遵循「一个事实只有一个家（One home per fact）」。Prompt 分层、模型能力选择、CI 归因与反震荡规则由该文档维护，不在入口复述。
- main 是集成/默认分支，无 dev。较大功能（公共 API、交易安全语义、跨多包新功能/重构）从最新 main 开 `feat/<issue号>-<短名>`，PR 关联 Issue 并至少一个审查批准；docs/notes、CI/脚本微调和单点修复等小改可直接 main，不强制 PR。此契约不代替当前提交/推送授权。见 [交付流分级](.agents/notes/implemented/process/2026-09-02-pr-flow-scope-refined.md)。提交用 Conventional Commits，只暂存核对过的精确文件。
- 构建/测试基线是 `pnpm build` 与 `pnpm test`；连接器另需真实网络原始响应证据（`spikes/impl-*/`）。按改动运行相关验证，完整门禁放在提交/推送及发布边界，不为纯指令编辑生成分发副本。
- 测试与 CI 棘轮：`pnpm test:audit`（BDD 命名/结构、零 mock、零 sleep、断言完整性）、`pnpm coverage:check`（分支/行/函数/语句四项覆盖率）、`pnpm test:scripts`（scripts/ 门禁自测）、`pnpm test:desktop`（桌面壳用例）。**新写测试必须合规**——棘轮只收存量债，任何规则或单文件计数上升即红，清债后用对应 `--update` 只降/只升地刷新基线。CI 分层：`ci.yml` = 静态门禁 + 三 OS 测试矩阵，`nightly.yml` = 覆盖率棘轮 + 抖动三连跑；发版管线闸门与静态门禁同源。见 [测试与 CI 棘轮](.agents/notes/implemented/testing/2026-09-15-test-hygiene-ratchet-and-tiered-ci.md)。

## 验收与重活执行的资源纪律

- **重活串行**：`pnpm gates:all`（build + `-r test` + 覆盖率 + typecheck）运行期间，不得再并发跑其他测试、drill 或验收 agent 的动态命令；同一时刻只允许一路重活，其余只做静态核对。2026-10-02 实测：并发运行把 load(15m) 推到 20+、swap 用到 4.4 GB。
- **跑完必查孤儿**：`ps -eo pid,ppid,command | awk '$2==1' | grep -E "node|electron|chrome"`。已知两类来源：`pnpm -r test` 的 vitest worker（父进程退出后残留）与 Electron 附着演练。
- **drill/长驻脚本必须按进程组回收**（`setsid` + `kill -- -PGID`），不要依赖脚本自身的清理；`desktop/scripts/attach-electron-drill.mjs` 已照此实现：Electron 以 `detached` 起进程组，`finally` 里 `kill(-pid)` 并等组清空（残留即判 FAIL、不自证清白）。它的"有没有派生本地 host"只看**自身进程树**（进程组 + ppid 链）—— 全机 `ps` grep `--profile trading-web` 会被机器上任何既存 trading-web 实例假红（2026-10-02 修）。
- **验收结论必须绑 commit**：并发会话会持续改动工作区（实测 10 分钟内未提交项 7 → 20），"工作区干净""N 例全绿""门禁全绿"这类声明必须现场复跑并记录 HEAD sha，不引用台账/检查点里的数字。
- **退出码不等于通过**：读输出里的 `[无报告]`/FAIL 行，不能只看 exit 0。`coverage:check` 曾在包收集失败时静默剔除该包并判通过，2026-10-02 已修（无报告即红、`--update` 也拒收），但"未验证 ≠ 通过"这条读法对所有门禁继续适用。

## 按需阅读

- 架构、五条铁律、数据源 ToS：[README.md](README.md)。
- 改包结构：[市场复制手册](docs/replication.md)；新增连接器：[接入手册](docs/connector-playbook.md)，先用 `scripts/new-connector.mjs` 生成。
- 改连接器激活/交易所选择：[设置路由](docs/exchange-routing.md)；查 spike 裁决：[REVIEW-LOG](spikes/REVIEW-LOG.md)。
- B站/微信内容提炼：[项目 content-insight](.agents/skills/content-insight/SKILL.md)，只交付请求产物；知识库写入需明确授权与当前工具，禁止直写活 store。

## 交易会话守则

正式分析标的、行业或宏观主题前，先用当前可用 `knowledge_search` 检索本地知识库；主题宽泛时先 `knowledge_graph` 看主体分布，再按 cluster 搜索、`knowledge_get` 读全文。工具不可用应如实说明，不能伪称已查库；无命中说明「知识库无相关沉淀」。卡片须标 id、核查 updatedAt 与素材发布时间，仅作观点线索，不替代原始披露和权威数据；过时宏观/政策观点降权，转述不等于背书，对外明示不构成投资建议。

新结论可建议用户按 knowledge-curation 查重后入库，不自动写库。交易日志遵守 trading-notes-setup 的双轨 append-only、先闸门后记账契约；外部工作区的便携守则由该 skill 写入 `.trading-journal/AGENTS.md`。
