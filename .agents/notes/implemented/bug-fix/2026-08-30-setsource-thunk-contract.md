# Agent Note: setSource thunk 误当 Config —— 运行时校验掐断 settings 接线

Status: implemented

## Problem

整改 #4（provider-vocabulary-open）首次交付后，trading-web 实测发现两处失效：
设置面板的「当前」解析值显示默认（应为 okx），且 GUI 保存看似成功却既不落盘
settings.yaml 也不改变运行时行为。

根因：`installSettingsSection` 的 hooks 契约是 `setSource(current: () => T)`——
传的是 **thunk**；实现把 thunk 当 Config 直接传给 `warnUnknownProviders(current)`，
`Object.entries(undefined)` 抛 TypeError。该异常发生在 installSettingsSection 的
inject 回调中段（`settings.register` 已执行、`scope.watch` 尚未接线），把设置
面板的远程读取/写回链路掐断。单元测试只覆盖了纯函数层（warnUnknownProviders 直接
传 Config 是对的），没覆盖 apply 接线层，所以构建全绿但运行时坏——典型的
「跨层契约（thunk vs 值）靠类型没兜住」：hooks 形参在实现侧被我错误窄化。

## Decision

修复 = 一行语义修正：`warnUnknownProviders(current(), log)`（先求值 thunk）。
配套回归测试：vitest 打桩 `@deepseek-ai/dsh-settings` 的 installSettingsSection，
捕获 hooks 后直证 `setSource(() => resolved)` 不抛、`onChange()` 不抛
（router.test.ts「apply 的 installSettingsSection 接线」）。

## Alternatives considered

- **把 warn 校验挪进 onChange（内部自行读 source）**：落选——onChange 无参，需要
  再调一次 service.source()，与 setSource 时机耦合更隐晦；在 setSource 里求值
  校验最直接，且回归测试锁定了 thunk 语义。
- **改 installSettingsSection 上游契约为传值**：不可行——DSH checkout 只读
  （版本基线铁律），且 thunk 设计本身是为了让消费方始终读到 live resolved。

## Consequences

- trading-web 实测闭环（2026-08-30）：面板正确显示「当前：okx」→ GUI 选 Binance
  保存 → settings.yaml 落盘 → **无进程重启** `/dshtrading/api/markets` 翻转
  provider=binance → `BTCUSDT` 报价从 OKX 词汇错误变为 Binance 真实行情
  （78178.05）。这正是整改 #1 承诺的 GUI 热切换。
- 附带上游观察（与本次修复无关）：settings-file 的 chokidar 文件监听在本次实测中
  未见外部手编 YAML 的传播（无 reload 日志、无 commit），GUI 官方写路径完全正常；
  已在 exchange-routing.md 生效时机口径内（手编文件场景建议新建会话/重启兜底），
  上游升级时按 upstream-upgrade-checklist §3 settings 行复查。
- 验证：router 12 例绿（含新回归用例）；全仓 build/test 绿。
