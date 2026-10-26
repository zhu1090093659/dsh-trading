# Agent Note: 空白 hero 的融合历史面板跟随当前承载容器挂载（seat 晚到 / 对话列整列替换）

Status: implemented

## Problem

交易壳的「历史会话」融合面板（`HomeHistory`，设计事实见
[右栏退役](../architecture/2026-08-30-right-rail-retire-hero-fusion.md)）在**新建会话后的对话列空白
hero** 上永久缺席：DOM 里查不到 `div[data-dshtrading-home-history]`，也完全没有「历史会话」文案。

2026-10-26 在真实宿主（profile `trading-web`）上多次实测，同一个症状有两种进入时序：

- 行情首页：`document.body.dataset.dshtradingHomeHistory === 'on'`、`[data-composer-seat]` 1 个、
  融合容器存在、正文含「历史会话」。
- 点「新建会话」进入的空白 hero（侧栏先挂、hero composer 后到）：同一 body 标志仍为 `on`、seat
  在位，但没有融合容器——挂载 effect 只依赖 `[blank]`，里面 `document.querySelector('[data-composer-seat]')`
  取不到就直接 `return`，此后没有任何重试。
- 点「新建会话」进入的空白 hero（宿主整列替换对话列）：body 标志仍为 `on`、`blank` 全程不变、
  seat **仍然存在**（新的元素实例，父容器类名同为 `scrollBody`），但融合容器是 0 个，等 1 s / 3 s /
  8 s 都不回来——旧的对话列子树整条被换掉，旧容器随之离场，而 effect 的依赖 `[blank, seatEpoch]`
  一个都没变，**effect 根本不重跑**。

归因是一句话：面板的挂载时点由宿主决定，插件只拿到 `sidebar.workspaces` 的渲染时机，之后宿主怎么
替换对话列都不通知。「查一次就返回」与「依赖不变的 effect」都会让面板在该视图永久缺席；等 seat 只是
必要条件，还要在承载容器被换掉之后重新拼。

## Decision

融合 effect 仍只依赖 `[blank, seatEpoch]`，两条时序都用同一个动作收敛——**元素身份变了就递增
`seatEpoch` 重跑整条挂载**——重跑后仍走原样未动的 `findCard` / `fuse` / `adopt`，几何、色板采样、
圆角抹平与还原一行未改：

- **seat 缺席**：挂一个 `MutationObserver`（`document.body` 的 `childList` + `subtree`），查到 seat
  即刻 `disconnect()` 并递增代际。
- **挂载之后（承载容器跟随）**：另挂一个 `carrier` 观察者（同样 `document.body` 的 `childList` +
  `subtree`），每次回调只做 O(1) 的身份比较，判据只有两条：容器已脱离 DOM
  （`container.isConnected === false`），或 seat 的元素身份变了 / 换了父节点
  （`seat.parentElement !== container.parentElement`）。命中即断开自己、置 `remounting` 闸门并递增
  代际——effect cleanup 先拆旧容器、还原卡片底圆角、断开全部观察者，再在**当前**承载容器里重拼，
  同一时刻只有一个融合容器。
- 判据**绝不**是「有 mutation 就重跑」：融合容器自己的 portal 渲染就落在被观察的 body 子树里，
  那样会自触发成死循环（本仓库有过 Observer 死循环的先例，见右栏退役 Note 与
  `HomeHistory` 里 seat 观察者的注释）。无关的 mutation 只换来一次身份比较，容器实例不变。
- 等待与重拼都是事件式的：没有 `setTimeout` / `setInterval` / rAF 猜测，也不轮询。
- 可见性语义不动：当前会话为 blank（hero 态）才挂载，打开非 blank 会话整板让位。

## Verification

- `packages/client-ui-trading/test/home-history-seat-wait.test.tsx`（9 例，零 mock、零 sleep）：
  「整列替换后重新挂进新承载容器且全页只有一个容器」、「同列内换 seat 后跟到同一个承载容器」、
  「seat 晚到后挂上」、「seat 已在时当场挂上」、「卸载后容器为 0 且重进只有 1 份」、「非 blank 不物化」、
  「无关 mutation 不重建容器」、「无 seat 时卸载后 seat 再到达也不再挂载」、「卸载后宿主再整列替换
  也不物化容器且圆角已还原」。
- 反向验证覆盖的是哪条路径：把 `carrier` 观察者摘掉（即上一轮的状态）重跑同一文件，只有「整列替换」
  与「同列内换 seat」两例失败（2 failed / 7 passed），其余七例照过——证明这两例锁的是承载容器替换，
  不是 seat 晚到。
- `pnpm --filter @dshtrading/client-ui-trading test`：604 passed；`pnpm build` 通过；
  `pnpm test:audit` 通过（无新增测试债）。

## Alternatives considered

- **有 mutation 就重跑**：本容器的 portal 渲染也在被观察的 body 子树内，会自触发成死循环，必须靠
  元素身份比较才安全；放弃。
- **轮询 / rAF 重试**（`setTimeout` / `setInterval` 反复查 `container.isConnected`，或重试若干帧）：
  要自带超时与取消，静默期照跑，是仓库纪律明令禁止的等待形态；帧数上限只能猜，后台标签页 rAF 被
  宿主冻结是已知坑；放弃。
- **在对话列另放兜底入口**（会话列头部再放一个「历史会话」按钮）：等于两份 UI、两套点击热区，
  hero 卡下方会多出一条割裂的列表带，而且没有解决融合容器缺席本身；放弃。
- **推迟 `sidebar.workspaces` 的挂载时刻**：该 slot 由宿主渲染，插件无法推迟宿主的挂载时机；放弃。
- **把容器改挂在 `document.body` 上靠 fixed 定位对齐**：宿主对话列是滚动容器，脱离它就等于自己重写
  滚动与层叠，几何拼接（宽度、上缘、底圆角抹平）全部作废；放弃。

## Consequences

- 空白 hero 与行情首页共用同一套拼接代码，两条路径的差别只剩「seat 是否已在 DOM 里、承载容器是否
  还是同一个元素」。
- 稳态成本：每批 observed mutation 一次 O(1) 身份比较（不查 `querySelector`），只有容器脱离或 seat
  换人时才真的重拼；重拼本身是 effect 整条重跑一次。
- 剩余风险：
  - 连续多次整列替换：`remounting` 闸门保证每次替换只递增一次代际。宿主同一批内「摘 A + 挂 B」时
    重跑当场命中新 seat 直接重拼；分两批时先落到等待器上，B 到达再拼——两种都不会留下第二个容器，
    但会看到一次极短的空窗。
  - 宿主若长期不给出 seat（DOM 结构改名、hero 换实现），两个观察者在 body 子树上的回调会随页面
    高频变动持续触发；正常竞态窗口只有几十毫秒，结构大改才会让它长期存在。
  - `[data-composer-seat]` / `[data-conversation-scroll]` 契约本身失效时整条融合挂载失效，与既有
    「启发式找卡」是同源风险。
  - 同列内只换卡片不换 seat 时由 seat 子树的观察者加 `findCard` 的身份校验
    （`card.isConnected && seat.contains(card)`）兜住，不经过本次的 `carrier` 判据。
