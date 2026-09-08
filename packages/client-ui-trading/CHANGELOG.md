# @dshtrading/client-ui-trading

## 0.1.6

### Patch Changes

- 770878d: 修复 2026-09-08 代码审查发现的问题：自选 store 单实例化（agent 工具写不再覆盖 GUI 写与分组归属）、未定制市场分组时种子基线完整物化、东财符号形态按实例市场分流 + 港股时间戳 UTC+8 锚定、futu 行情面按市场分实例（美股搜索不再返回港股）、旧 DSH_HOME 一次性数据迁移与 Windows 卸载清理目标修正、OpenD 桥订阅槽 LRU 淘汰，以及配套测试补齐（含两条此前不可失败的冒烟用例）。
- Updated dependencies [770878d]
  - @dshtrading/dsh-home@0.1.6
  - @dshtrading/watchlist@0.1.6
  - @dshtrading/api@0.1.6
  - @dshtrading/client-ui-knowledge@0.1.6
  - @dshtrading/client-ui-strategies@0.1.6
  - @dshtrading/eventbus@0.1.6
  - @dshtrading/holdings@0.1.6
  - @dshtrading/indicators@0.1.6
  - @dshtrading/kit-cn@0.1.6
  - @dshtrading/kit-crypto@0.1.6
  - @dshtrading/kit-hk@0.1.6
  - @dshtrading/kit-us@0.1.6
  - @dshtrading/knowledge@0.1.6
  - @dshtrading/router@0.1.6
  - @dshtrading/strategies@0.1.6

## 0.1.5

### Patch Changes

- @dshtrading/api@0.1.5
- @dshtrading/client-ui-knowledge@0.1.5
- @dshtrading/client-ui-strategies@0.1.5
- @dshtrading/eventbus@0.1.5
- @dshtrading/holdings@0.1.5
- @dshtrading/indicators@0.1.5
- @dshtrading/kit-cn@0.1.5
- @dshtrading/kit-crypto@0.1.5
- @dshtrading/kit-hk@0.1.5
- @dshtrading/kit-us@0.1.5
- @dshtrading/knowledge@0.1.5
- @dshtrading/router@0.1.5
- @dshtrading/strategies@0.1.5
- @dshtrading/watchlist@0.1.5

## 0.1.4

### Patch Changes

- 修复 HomeHistory 面板容器层级：composerStack（z-index:1）盒子下缘盖进 header
  行，静态 portal 容器整层被压其下——背景透明可见但点击不达，删除与折叠按钮同
  遭殃。容器建立时内联 relative + z-index:2 盖回；合成 click 测不出该缺陷，以坐
  标级 Input.dispatchMouseEvent + elementFromPoint 复归验证通过，composer 无误
  伤。
  - @dshtrading/api@0.1.4
  - @dshtrading/client-ui-knowledge@0.1.4
  - @dshtrading/client-ui-strategies@0.1.4
  - @dshtrading/eventbus@0.1.4
  - @dshtrading/holdings@0.1.4
  - @dshtrading/indicators@0.1.4
  - @dshtrading/kit-cn@0.1.4
  - @dshtrading/kit-crypto@0.1.4
  - @dshtrading/kit-hk@0.1.4
  - @dshtrading/kit-us@0.1.4
  - @dshtrading/knowledge@0.1.4
  - @dshtrading/router@0.1.4
  - @dshtrading/strategies@0.1.4
  - @dshtrading/watchlist@0.1.4

## 0.1.3

### Patch Changes

- @dshtrading/api@0.1.3
- @dshtrading/client-ui-knowledge@0.1.3
- @dshtrading/client-ui-strategies@0.1.3
- @dshtrading/eventbus@0.1.3
- @dshtrading/holdings@0.1.3
- @dshtrading/indicators@0.1.3
- @dshtrading/kit-cn@0.1.3
- @dshtrading/kit-crypto@0.1.3
- @dshtrading/kit-hk@0.1.3
- @dshtrading/kit-us@0.1.3
- @dshtrading/knowledge@0.1.3
- @dshtrading/router@0.1.3
- @dshtrading/strategies@0.1.3
- @dshtrading/watchlist@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/api@0.1.2
- @dshtrading/client-ui-knowledge@0.1.2
- @dshtrading/client-ui-strategies@0.1.2
- @dshtrading/eventbus@0.1.2
- @dshtrading/holdings@0.1.2
- @dshtrading/indicators@0.1.2
- @dshtrading/kit-cn@0.1.2
- @dshtrading/kit-crypto@0.1.2
- @dshtrading/kit-hk@0.1.2
- @dshtrading/kit-us@0.1.2
- @dshtrading/knowledge@0.1.2
- @dshtrading/router@0.1.2
- @dshtrading/strategies@0.1.2
- @dshtrading/watchlist@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/api@0.1.1
- @dshtrading/client-ui-knowledge@0.1.1
- @dshtrading/client-ui-strategies@0.1.1
- @dshtrading/eventbus@0.1.1
- @dshtrading/indicators@0.1.1
- @dshtrading/kit-cn@0.1.1
- @dshtrading/kit-crypto@0.1.1
- @dshtrading/kit-hk@0.1.1
- @dshtrading/kit-us@0.1.1
- @dshtrading/knowledge@0.1.1
- @dshtrading/router@0.1.1
- @dshtrading/strategies@0.1.1
- @dshtrading/watchlist@0.1.1
