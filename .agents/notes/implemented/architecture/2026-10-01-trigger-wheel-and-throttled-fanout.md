# 触发器与扇出：持久 timer wheel、补算错过、节流扇出

日期：2026-10-01 · 阶段：P3 步骤 3 · 卡片：317a623f · 包：`@dshtrading/tradectl/triggers`

## 事实

- **核心自建，不依赖官方 schedule/webhook**：触发必须与账本同生共死，而不是寄居在一个可以被单独重启/升级的宿主插件里。
- **调度表与 occurrence 都落在 orders.db**（`synchronous = FULL`，与钱同一个耐久档）：错过的触发是风险相关事实，静默丢掉它就是"该减的风险没减"。occurrence 主键 `(scheduleId, dueAtMs)` 天然幂等——同一个触发点重复触发不是新事件。
- **`dueOccurrences` 是唯一的触发入口**：重启后的第一次调用就是"补算错过"，没有第二条捷径可以绕过它。
- **错过只能减风险**：错过的 occurrence 带 `missed` 标记，整批以 `reduceOnly: true` 扇出。理由：错过的开仓信号**不能**补执行（价格早变了），错过的风控/减仓信号**必须**补上。
- **节流扇出**：`followup` 每次都是一条独立普通 turn（官方语义），窗口内最多扇 `maxPerWindow` 条，多出来的**合并进同一条**并带上完整 occurrences 与"合并了几条"的文本——**合并不等于丢**，丢才是问题。
- **扇出失败不吞**：返回 `failed` 并把 occurrence 记为 `failed`（可查、可重试、attempts 递增）。
- **换代只换 sessionId**：wheel 不持有任何会话状态，权威态在账本，所以 desk 会话换代后新会话从账本继续。
- **tick 的顺序是先记账后推进 nextAt**：崩在中间最坏是重复扇出一次（幂等兜住），而不是静默少扇一次——两种失败的代价不对称。

## 测试（10 例新增，tradectl 累计 83 例全绿）

未到点/到点/下一周期各一次；**重启错过 5 条全部以 missed 出现且整批 reduceOnly**；同一触发点不重复扇出；窗口内 6 条合并成 1 条且一条不丢；扇出失败如实记 failed；换代后新会话拿到新触发且账本留痕（权威态不在会话）；markFired 幂等（重复标记只增 attempts）；advanceSchedule 跳过中间点、一次性调度自我禁用；禁用调度不触发；扇出文本内容。真 `node:sqlite` + 注入时钟 + 契约假 followup，无 mock 无 sleep。

## 未验证项（如实标注）

- **与官方 `ctx.agents.get(deskSessionId).followup(...)` 的真实接线未做**：本轮实现的是扇出端口（`FanoutPort`）与节流器，测试用注入的 followup。真实接线要在 bot 宿主进程里落地，属步骤 5（shadow 跑批）的前置。
- **timer wheel 的驱动频率与 tick 的真实定时器未接**：模块只提供 `tick(nowMs)`（纯函数式推进，测试友好）；进程内的 setInterval/事件泵属接线，未做。
- **调度表的写入面（谁加调度）未定**：本轮只有 `addSchedule`，编排来源（mandate/风控/宏观日历）属后续步骤。

## 被否决的方案

- **用官方 schedule/webhook 插件**：卡片明确要求核心自建；而且触发与账本必须同生共死（宿主可被单独重启/升级）。
- **occurrence 只记在内存**：重启即丢，正是卡片禁止的"静默消失"。
- **扇出超限就丢弃**：桌面会话被刷爆是问题，丢触发是更大的问题；改成合并。
- **错过的触发按原语义补执行**：错过的开仓信号补执行等于用一个过期的判断去开新仓。
