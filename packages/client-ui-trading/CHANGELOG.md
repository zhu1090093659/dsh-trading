# @dshtrading/client-ui-trading

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
