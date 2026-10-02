# docs/ 目录收敛与事实归家（2026-10-02）

## 事实与决策

- **docs/ 顶层布局（现在时）**：根目录只留 `README.md`（索引）与 `current-state.md`（交接事实入口）；其余按主题收敛进四个子目录：
  - `docs/guides/`：symbol-vocabulary / exchange-routing / connector-playbook / connectors-guide / replication / skills-guide / okx-integration
  - `docs/ops/`：running / ops-runbook / release-checklist / upstream-upgrade-checklist
  - `docs/roadmap/`：p5-acceptance-checklist / analysis-roadmap
  - `docs/client/`：mobile-app-plan
  - `docs/design/` 与 `docs/archive/` 维持原位。
- 14 个文件全部用 `git mv` 迁移（git status 全部识别为 R 重命名，历史保留）。
- **事实归家裁定**（一个事实只有一个家）：
  - 第 2 档（paper）**档位状态**的家 = `docs/roadmap/p5-acceptance-checklist.md`「三档现状」表；**执行记录本体**的家 = `docs/ops/ops-runbook.md`「演练记录」节。runbook 内残留的「（待执行）/状态：未执行」标题与下方已通过记录自相矛盾，已改为「已通过」并把状态判定指向三档现状表。
  - 移动端**工程实测与操作**（工具链表、BUILD SUCCEEDED 证据、首次引导命令、「尚未做」清单）的家 = `apps/ios-native/README.md`（2026-10-02 本裁定当时指向 `apps/mobile/README.md`；该 Expo/RN 工程已按 owner 2026-10-02 决定退役删除，家随之归到原生观测端）；`docs/client/mobile-app-plan.md` 保留落仓形态、分发决策、CI 策略（另含退役裁决），重复内容已改为指针（三处）。
  - `docs/current-state.md` 已验收表 vs runbook 演练记录：**角度不同，合规**（交接摘要 vs 运维证据），不改。
- **入口**：`docs/README.md` 索引树重写为子目录结构，新增第 0 条入口（current-state），并补上 ops-runbook / p5-acceptance-checklist / mobile-app-plan 三个此前缺失的索引项。AGENTS.md → docs/current-state.md（文档地图）→ 任意事实 ≤ 3 跳。
- 链接更新方式：脚本对全仓 tracked md 做「字面 `docs/<old>.md` → 新路径」（140 处）+「相对链接解析后命中旧路径则重写」（15 处），共 60 个文件；另手工修复搬家文件内部相对深度 5 处（`docs/ops/running.md`×2、`docs/ops/ops-runbook.md`×2、`docs/guides/exchange-routing.md`×1）。

## 门禁证据（2026-10-02 现场实跑）

- `pnpm docs-link:check`：336 markdown / 271 相对链接 / **无新增断链**；基线 18 条存量债（全在历史 Note，与本次无关）只降不升达成（18 → 18，未动基线文件）。
- `pnpm i18n:check`：OK（5 namespaces, 992 zh keys）。`pnpm contract-id:check`：✓ 831 文件。

## 约束（改 docs/ 布局前先读）

- 新增文档须落对应子目录；根目录只允许 README.md 与 current-state.md。
- 移动端工程实测写 apps/ios-native/README.md，不要在 plan 里复制表格。
- 第 2 档状态写 p5-acceptance-checklist 三档现状表；执行记录追加在 ops-runbook 演练记录节。
