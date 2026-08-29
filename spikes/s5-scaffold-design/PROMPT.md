# S5 包规范与脚手架设计

> 执行方式：headless DSH 会话（dsh --profile spike-runner），cwd 为本目录。

【项目背景】dsh-trading：基于 DeepSeek Harness (DSH) 的交易插件包体系（按市场分包：crypto/us/cn/hk）。你是第 0 阶段 spike 验证的执行者之一，以独立 headless DSH 会话运行。项目根 README（/Users/zcl/code/dsh-trading/README.md）有完整架构决策，先读。

【环境事实 — 均已核实】
- DSH 版本基线 0.1.2-alpha.1（从源码 checkout 运行）。官方源码 checkout（只读参考！禁止修改、禁止 build、禁止在其中安装依赖）：/Users/zcl/code/deepseek-harness
- 本机 dsh 命令：~/.local/bin/dsh。数据目录 ~/.dsh 共享。
- 现有 profile：default / headless / web / liangshen-headless / liangshen-test / v2accept / spike-runner —— 一律禁止触碰；禁止重启或停止任何正在运行的 dsh 进程（有 Web GUI 正在 127.0.0.1:3080 运行）。spike-runner 是运行基座，不许往里装东西。
- 你只能创建/使用分配给你的 spike profile（dsh plugin --profile <名> 首次使用自动初始化，初始 bundles=[dsh-base]，patchReload:live）。
- 已知环境坑（已证实）：home 级 ~/.dsh/cordis.patch.yml 含 web-search-exa 行，对所有 profile 生效；安装闭包里该包是指向已删除 staging 的悬空符号链接，导致任何新 profile 启动崩溃。解法：给你的 spike profile 加 file: 依赖指向 /Users/zcl/code/deepseek-harness/packages/web/web-search-exa（参照 spike-runner 的做法）。
- 需要 headless 应用层时：bundle 列表加 /Users/zcl/code/deepseek-harness/packages/bundle/headless（npm 上只有远古 RC，必须用本地路径；spike-runner 的 package.json 是现成参照）。
- 模型凭证：API key 经 harness 凭据存储解析；若模型调用因凭证失败，把机制验证到那步为止，报告注明「机制 PASS / e2e 受凭证阻断」。模型调用全程最多 1-2 次短 prompt。

【纪律】
- 禁止自己派生子 agent；不发布任何 npm 包；不修改全局 settings.yaml 或 home 级 ~/.dsh/cordis.patch.yml；不在项目根目录创建文件（只在分配给你的 spikes/ 子目录内工作）。
- 时间纪律：目标 25 分钟内完成；REPORT.md 尽早建骨架、随进展更新，避免最后一次性写。
- 交付：REPORT.md（结论 PASS/FAIL/UNCERTAIN → 关键证据（命令+输出摘录）→ 机制细节 → 发现的坑 → 对正式实现的建议），最终回复用中文 ≤300 字总结。
- 关键参考（DSH checkout 内，有中文版）：apps/cli/README.zh.md、packages/bundle/README.zh.md、docs/user/develop/、docs/config-catalog.zh.md。

【你的任务 S5】调研「第三方 DSH 插件/bundle 包官方规范」并设计 dsh-trading monorepo 脚手架。只读 DSH checkout；产出放 /Users/zcl/code/dsh-trading/spikes/s5-scaffold-design/。
要点：docs/user/develop/ 全扫（SDK 边界）；包解剖 skill-badge/package.json（最小插件）、bundle/base/package.json（bundle）、tool-cordis/package.json（工具插件）的 main/exports/files/dsh.* 与 lib/ 布局；构建链（tsdown.config.ts、根 scripts、插件入口 default export 形态）；monorepo 组织（pnpm-workspace.yaml、changesets 约定）。
产出：REPORT.md（规范事实清单，引用 文件:行号，写清第三方包被 dsh plugin add 后的完整加载链路）+ TEMPLATES.md（根 package.json/pnpm-workspace.yaml/tsconfig.base/插件包与 bundle 包模板/changesets 草案）。标注哪些复制适配官方、哪些是设计提案。