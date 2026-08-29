# Spike 运行手册（2026-08-29）

## 运行基座：spike-runner profile

- 创建：`dsh plugin --profile spike-runner add <exa 本地路径>` + `add <headless bundle 本地路径>`
- 组合：bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless]，patchReload: live
- 用法：`cd <spike 目录> && dsh --profile spike-runner "$(cat PROMPT.md)"`
- 模型：agent-default-model = zai-coding-cn/glm-5.3-flash；路由默认 reasoning: max（2026-08-29 设置，见 settings.yaml.bak-zai-reasoning-max-*）

## 环境坑（已证实）

1. **exa 悬空符号链接**：~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-search-exa → 已删除的 staging-20260811；home patch 对所有 profile 含 exa 行 → 新 profile 启动必崩。解法：profile 内 file: 依赖指向 /Users/zcl/code/deepseek-harness/packages/web/web-search-exa。（用户现有 headless profile 也因此损坏，未修——超出本阶段范围。）
2. **npm 只有远古 RC**：@deepseek-ai/dsh-headless 等 npm 上是 0.0.1-rc.1；bundle 必须用本地源码路径。
3. **run_code 10 分钟硬顶**：前台 workflow 编排 5 个长任务会被杀（已发生一次）；改用后台 headless 会话。
4. **zai-coding-cn 5 小时限额**：2026-08-29 触顶，18:06:39 重置；备选等价路由 zenmux/z-ai/glm-5.3-flash（用户此前的子 agent 默认）。
