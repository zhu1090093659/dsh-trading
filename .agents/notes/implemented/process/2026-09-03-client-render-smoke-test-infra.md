# Agent Note: client-ui-trading 渲染冒烟测试基建（评审遗留收口）

Status: implemented

## Problem

2026-09-03 PR #55 评审整改中，viewTab 声明顺序 TDZ 导致 QuoteStage 渲染即崩、
整个中栏 slot 消失——tsdown 构建（无类型/引用期检查）与 790 条逻辑单测均未发现，
靠 live 验证才捕获。client-ui-trading 是三个 client-ui 包里唯一没有渲染测试基建的
（client-ui-strategies 已有 @testing-library/react + jsdom 模式）。

## Decision

- 引入与 client-ui-strategies 同款基建：devDeps 加 @testing-library/dom+react、
  jsdom、react-dom；新增 vitest.config.ts（node 默认 + 文件内 jsdom 指定）；
  tsconfig.json 补 "jsx": "react-jsx"（esbuild 按就近 tsconfig 转译测试 tsx，
  与 include 无关——strategies 既有裁决原文沿用）。
- test/quote-stage.smoke.test.tsx：QuoteStage crypto/us 双市场渲染 + 衍生品页签
  切换、DerivativesStage 全量/降级/次新永续三分支、DerivativesPane 入口点击。
  TvChart（lightweight-charts）以 vi.mock 打桩；fetch 桩 500 走降级路径。
- 有效性实证：临时重引入 viewTab TDZ，冒烟测试如预期全红报
  "Cannot access 'stageTab' before initialization"，回退后全绿。

## Consequences

- 此后 QuoteStage 及衍生品组件的 TDZ/顶层渲染崩溃在 pnpm test 阶段即拦截，
  不再依赖 live 验证兜底。
- 其它 client-ui 包加渲染测试时直接复用本包配置模式。
