# Agent Note: 移除内置的第三方 IM 机器人插件 @xmanrui/dsh-im

Status: implemented

## Problem

2026-09-06 起 `@xmanrui/dsh-im` 作为 npm 复用的社区插件随包内置：`packages/gui` 的
`cordis.patch.yml` 里一行 `dsh-trading-im` 承担飞书/微信/钉钉/企业微信/QQ/Slack/
Telegram/Discord/WhatsApp 九渠道机器人接入，包名解析依赖 `packages/gui/package.json`
的 `@xmanrui/dsh-im` 依赖进入 profile 安装闭包。该插件是**第三方社区包**（scope
`@xmanrui`），不是官方 `@deepseek-ai` cohort 的一部分，也不随本仓一起被验证。

owner 裁决不再内置第三方 IM 插件。

## Decision

同一次变更里连根摘除四个面，不留半截：

1. **挂载行**：`packages/gui/cordis.patch.yml` 删除 `dsh-trading-im` 整行（含它的
   条件禁用表达式与 19 行说明），原位只留三行移除记录指向本文——与本文件里
   session-archive / usage 两行的移除写法一致。
2. **依赖边**：`packages/gui/package.json` 删除 `@xmanrui/dsh-im` 依赖。
3. **放行条目**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 删除
   `@xmanrui/dsh-im@4.20.2`；该块的注释同步改写——清单里已经不再有任何本仓自带的
   第三方包，旧注释里「尾部保留第三方条目（@linxin666/*、@xmanrui/*）」与事实相反。
4. **契约登记**：`scripts/patch-id-freeze.json` 用 `node scripts/patch-id-gate.mjs --update`
   删掉 `dsh-trading-im`（54 条契约行 / 1 处覆盖），**理由即本段**：行 id 是跨版本
   公共契约，有意删除的登记方式就是 `--update` 加 Agent Note 记录，不是悄悄消失。
   `dsh-trading-im` 从此不再是契约行；回滚要连行、依赖、放行条目、冻结登记一起恢复。

## 后果与残值（如实）

- 安装闭包：`pnpm install` 报 `Packages: -99`，该插件及其全部传递依赖退出闭包。
- 能力面：九渠道 IM 机器人接入、设置面板里的「IM机器人」分区（section order 21）
  一并消失。这是 owner 明示的取舍，不是回归。
- **已安装用户不会自动干净**：本仓内置的是 patch 行，用户 profile 里若曾按旧指引
  执行过 `dsh plugin add @xmanrui/dsh-im`，那条 profile 侧安装与其自带 patch
  （id `xmanrui-dsh-im`）仍在，本仓的移除管不到它——需要用户在自己的 profile 里
  自行卸载。本仓能做的是：内置行与依赖边不再把包带进新 profile 的安装闭包。
- `packages/gui/package.json` 依赖块因删除末项需要同时去掉上一行的尾逗号，否则
  JSON 直接语法错误；已按 JSON 校验确认（`node -e require(...)` 通过，9 条依赖）。
- 历史叙述不重写：`2026-09-06-dsh-im-npm-embed.md` 保留为当时的决策记录，只在
  Status 行加指向本文的后继说明；`2026-10-01-three-plane-package-split.md` 里枚举
  当年行集合的历史句同样保留。

## 验证

- `node scripts/patch-id-gate.mjs` ⇒ `✓ 11 个 patch 层：54 条 dsh-trading-* 契约行唯一且已登记`。
- `node -e 'require("./packages/gui/package.json")'` 通过，`xmanrui present: false`。
- `grep -rn xmanrui packages/gui/package.json pnpm-workspace.yaml` ⇒ 0 残留。
