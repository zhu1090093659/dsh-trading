# Agent Note: 金十快讯热度筛选（火/热/沸/爆，网页版服务端过滤）

Status: implemented

## Problem

用户 2026-09-13 要求快讯支持按热度筛选，默认只看「热、爆」，并给出金十网页版的热度筛选 UI（火/热/沸/爆 可多选、全选、恢复默认）；2026-09-14 用户将默认口径收窄为「沸、爆」。现状只有官方 MCP 快讯面：list_flash 的 inputSchema 只有 cursor，额外参数被上游以 unexpected additional properties 拒绝；条目也只有 content/time/url，没有热度。网页版对快讯确有四级热度且**服务端过滤**，但走的是另一套非官方入口（www.jin10.com 前端 bundle 逆向出的 HTTP 接口）。

## Decision

1. connector-jin10 新增 `web-flash.ts`：`fetchJin10HotFlash` 复刻网页版请求（endpoint + x-app-id/x-version + channel[1,5,9] + hot + max_time），把条目映射为本仓 NewsItem（标题取 data.title，空则从 content 的【…】提取；url = https://flash.jin10.com/detail/<id>；publishedAt 解析东八区），并带 hot 标签；正文 content 不下发。常量 `JIN10_HEAT_LEVELS = [火,热,沸,爆]`。
2. `Jin10Service` 新增 `listFlashByHeat`（web fetch 可注入便于单测，超时 15s）。既有 MCP `listFlash` 不动。**2026-10-15 更新**：agent 工具面同步扩到这条路——`flash_list` 增加可选 `hot` 参数（多值逗号分隔），给了 `hot` 就走 `listFlashByHeat`、不给仍走 MCP `listFlash`（行为与改动前逐字一致）；此时出参 `source` 如实标注为网页版热度入口而非 MCP feed（原先把热度页标成 MCP feed 是错的）。网页版热度页上游无条数参数，`limit` 由本仓本地截断并在页头回带上游页大小。
3. `flash-service.ts`（GUI 桥的 tradingFlashFeed）：listFlash 的 hot 含有效等级 → 走 listFlashByHeat（服务端过滤）；否则走 MCP 全量流。`FlashFeedService.listFlash` 增加 hot 选项，共享 `NewsItem` 增加可选 `hot`。
4. 桥 `GET /dshtrading/api/flash` 增加 `hot` 查询参数（逗号分隔；未知等级 → 协议 400，不静默降级）；client `fetchFlash` 透传。
5. GUI `FlashPanel` 增加热度筛选（四段连选、可多选 + 全选 + 恢复默认；默认 `[沸,爆]`），热度过期即重载；`NewsFeedPane` 渲染 hot 徽标（分档配色）。
6. 非官方接口边界：官方 MCP 仍是主入口，只有热度路径走网页版；只下发标题/时间/链接/热度标签（铁律 #5）。

## Evidence（真实网络，2026-09-13）

- 原始证据：[spikes/impl-jin10-heat-flash/EVIDENCE.md](../../../../spikes/impl-jin10-heat-flash/EVIDENCE.md) + `EVIDENCE/*.json`。实测：不带 hot → 50 条（49 空+1 热）；`[火]`/`[沸]`/`[爆]` 各 50 条全为该档；`[热,爆]` → 热 38 + 爆 12；max_time 翻页无重叠。
- 构建产物 live：`feed.listFlash({ hot: [热,爆] })` → 49 条（37 热 + 12 爆），title/url/publishedAt 齐全。
- GUI live（profile 刷新 + 桌面壳重启 + 无头 Chrome CDP）：点右缘「快讯」→ 面板挂载、body 标记 on；热度段选 火:false / 热:true / 沸:false / 爆:true（默认 热+爆）；49 条均带 hot 徽标（37 热 + 12 爆）。截图证据 `/tmp/flash-heat.png`（会话临时，未入库）。
- 2026-09-14 默认口径收窄：仅改 `DEFAULT_HEAT`（`[热,爆]` → `[沸,爆]`）与其注释、冒烟断言；`client-ui-trading` 相关用例全绿。
- 门禁：connector-jin10 8 文件 / 75 例（新增 web-flash 5 例、flash-service hot 路由 2 例）；client-ui-trading 47 文件 / 394 例（新增 flash-panel 热度冒烟 3 例、bridge hot 2 例）；两包构建全绿。

## Alternatives considered

- 只靠官方 MCP：做不到——上游无热度字段、无可筛选参数（实测报 unexpected additional properties）。
- 客户端按关键词启发式造热度：伪造数据，否决。
- 用网页版 classic flash-api 的 `important`(0/1)：只有二值，不是四档；且实测 hot/level 参数被忽略。否决。
- 抓网页版实时加密 WS（wss-flash-2，帧为加密/二进制）：不可解析；HTTP /flash 接口已够筛选与翻页。

## Consequences

- 新增热度筛选与 `hot` 字段；默认只看 沸+爆（2026-09-14 用户由 热+爆 收窄；网页版默认是四档全选）。
- 依赖一个非官方网页接口（写死逆向的 x-app-id，上游变更即失效）。失效时热度路径报错、面板显示可操作提示；MCP 全量路径不受影响。
- hot 是分类语义：勾选若干档 = 只返回该档已分类条目（未分类条目不在结果内）；清空所选则回落 MCP 全量流。
- 运行中的 trading 实例需刷新 profile / 重启宿主后才加载新构建。
