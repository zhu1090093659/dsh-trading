# @dshtrading/client-ui-updater

## 0.7.1

### Patch Changes

- 0.7.0 之后主干的四处现场修复（桌面壳 mygo 与根测试入口的改动不随包分发，不进包产物）。

  - **`@dshtrading/base`**：两阶段启动器适配宿主 0.2.2。宿主把 `tools` 从
    `system-prompt/assemble` 装配体里移走（服务在瀑布之后自行追加），`assembled.tools.map`
    直接抛 TypeError，研究员及其委派预设**每次首轮都崩**——改为读 `agent.ctx.tools.definitions(agent)`
    做组合判定。恢复首轮工具收窄：组装期已拿不到能影响本步的裁剪杠杆（返回的 tools 被丢弃），
    改为 `agent/status` 首次 running 时对未晋升会话 `agent.ctx.tools.restrict({ allow })`，
    限制在 `step/end`、`turn/end` 同步释放。trading-web 真机取证：研究员与委派预设首轮
    request/header 均为三个工具，模型调用一次工具后下一轮 139，宿主重启后续会话首轮仍 139。
    回归用例 `test/tool-bootstrap-assemble.test.ts`。

  - **`@dshtrading/client-ui-updater`**：`available` 改为按磁盘版本现算。它原本是上次检查那一刻的
    结论、家族版本却取宿主启动快照，增量 `apply` 或换包/reseed 之后 `state.json` 与内存里的
    `available: true` 都不再成立，右缘红点与面板一直挂着「发现新版本 X」，点「立即更新」还会
    白下载同一版 payload。家族版本改从 `client-ui-updater/package.json` 现读，`check`/`GET /state`/
    `POST /apply` 共用 `availabilityOf` 一个判据；`start()` 对账并就地改写 `state.json`。回归 4 例。

  - **`@dshtrading/client-ui-trading`**：KDAS 关键日线增删当场生效。主图叠加序列只在「组首次出现」时
    按当时输出集建立，而每条关键日是独立输出键，新增拿不到序列、移除撤不下序列，用户只能整页刷新；
    `syncIndicators` 改为组内输出结构 diff（先建缺席输出序列、再撤消失的输出序列、最后统一刷新），
    既有序列引用不变，视窗与 ticker 推进不受影响。借壳期间（`body[data-dshtrading-plugin-host='on']`）
    把会话列与主面板重新显形，插件整页不再失去布局盒。

  - **`@dshtrading/client-ui-settings`**：插件分区等待多出 `blocked` 结论——有内容但拿不到布局盒时
    超时点报「插件页被当前布局遮住」并给重试按钮，布局盒回来自动接管，慢、坏、被遮三种情形都不留白屏。
  - @dshtrading/dsh-home@0.7.1

## 0.7.0

### Patch Changes

- @dshtrading/dsh-home@0.7.0

## 0.6.3

### Patch Changes

- @dshtrading/dsh-home@0.6.3

## 0.6.2

### Patch Changes

- @dshtrading/dsh-home@0.6.2

## 0.6.1

### Patch Changes

- @dshtrading/dsh-home@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/dsh-home@0.6.0

## 0.5.0

### Patch Changes

- @dshtrading/dsh-home@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/dsh-home@0.4.1

## 0.4.0

### Patch Changes

- @dshtrading/dsh-home@0.4.0

## 0.3.0

### Patch Changes

- @dshtrading/dsh-home@0.3.0

## 0.2.1

### Patch Changes

- @dshtrading/dsh-home@0.2.1

## 0.2.0

### Patch Changes

- @dshtrading/dsh-home@0.2.0

## 0.1.6

### Patch Changes

- Updated dependencies [770878d]
  - @dshtrading/dsh-home@0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2
