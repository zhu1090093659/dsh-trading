# Agent Note: provider 词汇开放化 —— schema 不拒未知 slug，校验下沉

Status: implemented

## Problem

交易所路由的 provider schema 是封闭 enum（`Schema.union(PROVIDER_VOCABULARY)`）。
架构评审（2026-08-30）指出这使连接器生态锁死在「仓内受控」：第三方作者给
dsh-trading 写一个交易所连接器（注册自己的 slug）后，用户无法在设置里选中它——
schema 在写设置时就把未知 slug 拒掉。与「一切皆插件」的开放理念不符，而
指标系统（社区指标注册即上榜）已证明开放注册面在本仓可行。

同时必须守住安全面：下单闸门正则的保守性（只认市场前缀 + 已知语义词）不因此
松动——闸门白名单与 provider 词汇是两个独立面。

## Decision

1. **schema 开放**：`provider` / `tradeProvider` 从 `Schema.union(词汇表)` 改为
   `Schema.string()`——第三方 slug 不再被一票否决。
2. **运行时校验**：`warnUnknownProviders()`（router 包导出）在插件启动与每次
   settings 变更时跑——未知 slug 打 warn（说明「无内置连接器会激活，除非第三方
   连接器注册同名 slug」）并返回清单；行为 fail-soft（无激活），不再写时拒。
3. **UI 校验下沉**：设置面板的候选清单（PROVIDER_LABELS）保持不变——用户在 UI
   里只能选已知候选；若存储值是未知 slug（手编 YAML 或第三方接入），面板追加
   一个「自定义（slug，由第三方连接器提供）」选项，当前值不在 UI 上消失、可选回
   已知项。lead 文案同步「行情面板保存即生效；Agent 会话于新建会话生效」
  （注册表模式后的真实语义）。
4. **`PROVIDER_VOCABULARY` 保留**：从「schema 硬门槛」降级为「内置词汇表」——
   UI 显示名 + 运行时告警的唯一依据。

## Alternatives considered

- **保持封闭 enum，新交易所一律提 PR 进本仓**：落选——评审结论是该模式把
  「插件生态」变成「仓内垄断」；且 enum 变更 = router 包发版，接入节奏被本仓
  发布周期绑架。安全关切（乱写 slug 导致无行情）由运行时 warn + UI 候选清单
  覆盖，不需要 schema 级拒绝。
- **schema 开放 + 运行时直接拒绝激活（fail-hard）**：落选——未知 slug 可能是
  用户为未来连接器预先写的配置；warn + fail-soft 让配置可先存后装。
- **工具名/闸门正则同步开放**（任意 `<word>_place_order` 都进闸门）：**明确不做**
  ——闸门白名单的保守性是实盘安全特性，第三方连接器要获得真交易能力仍须其工具
  名落在既有市场前缀模式内（新市场才扩 base，手册既有口径）。开放的是「数据源
  提供方」面，不是「实盘下单」面。

## Consequences

- 第三方数据源/交易所连接器的最小接入路径：写连接器包（注册行情服务 slug）+
  用户 settings 写同名 slug——零本仓改动。真交易能力仍走仓内评审（闸门铁律）。
- 写设置不再因拼错 slug 被硬拒，代价是「选了没装」= 行情区报未激活——注册表的
  「选中未注册不静默降级」语义（2026-08-30-market-data-registry-hot-switch.md）
  使该状态对用户可见而非静默落到别家数据。
- 验证：router 11 例（新增 schema 开放 + warn 清单 2 例，原「enum 拒非法」文档性
  用例重写为真实断言）；client-ui-settings 5 例绿；`pnpm -r build` 全绿。
