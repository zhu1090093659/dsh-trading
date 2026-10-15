# Agent Note: 渲染进程日志先砍来源再砍原因——combo URL 曾把报错原因整段吃掉

Status: implemented

## Problem

`rendererLogLine()` 的行格式是 `[renderer] <level> <sourceId>:<行号> <message>`，截断时只压 `message`，`sourceId` 不受限。而客户端插件批的 sourceId 正是那条 **2.8 KiB 的 combo URL**（`/plugins/??<每个客户端入口>&rev=…`），于是 500 字符预算被 URL 独占，真正说明原因的那句 message 一个字符都留不下：

```
[renderer] error http://127.0.0.1:59547/plugins/??@deepseek-ai/dsh-client-ui-open-in-app/client.js,…(一路到 500 字符上限，全是 URL)
```

2026-10-15 排查桌面壳时实测到这条，无法判断是 431 / 404 / `net::ERR_ABORTED`——与 [cookie 撑爆请求头预算那条](2026-09-11-desktop-auth-cookie-header-overflow.md) 为找出 431 不得不开 CDP 抓 Network 是同一类盲区：日志里有记录，却读不出原因。

## Decision

`desktop/src/runtime.cjs`：来源字段先按 `RENDERER_LOG_SOURCE_MAX = 120` 收短，超出部分写成 `…(+Nch)`（保留"被砍了多少"的线索，不静默丢尾），之后才把剩余预算全给 message。`shortenRendererSource()` 对不超限的来源是恒等函数，既有行形（含 `RENDERER_LOG_LINE_MAX` 恰好 500 的用例）不变。

## Verification

- `desktop/tests/runtime.test.mjs` 新增一例：source 为 2.8 KiB combo URL、message 为 `Failed to load resource: … status of 431 …` 时，渲染出的行**包含 `status of 431`**、包含 `…(+`、总长 ≤ 500；短来源的既有 3 条用例（行形、换行收拢、500 上限）原样通过。`cd desktop && npm test` 44/44。
- 该次报错本身**未能复现**：同一台机器上用全新播种 home 起桌面壳，全部客户端批都干净加载（无对应 `[renderer]` 行）；在用户真实 home 上重启一次也没有再出现。归因留空——本条交付的是"下次再出现时日志会写明原因"，不是对那一次的结论。

## Alternatives considered

- **只记 URL 前缀（截掉 `??` 之后的入口列表）**：combo URL 的前缀对每批都一样，等于把"是哪一批"也丢了；保留 120 字符的来源仍能指认入口集合的开头，且与 `…(+Nch)` 的长度线索合起来够用。
- **给 plugin 批单独放一份完整 URL 到日志第二行**：单条 console 消息变多行，破坏"一条消息一行记录"的既有契约。
- **调大 `RENDERER_LOG_LINE_MAX`**：URL 长度随客户端插件数线性增长（本机 2.8 KiB），放大上限只是把问题推向下一批插件更多的时候。
- **在主进程加 `webRequest.onCompleted` 记录非 2xx**：能直接给出状态码，但那是新增观测面（每轮 GUI 的全部请求），超出这次"先把已有日志修得可用"的范围；若同类盲区再出现，它是下一步。

## Consequences

- 之后任何一条 `[renderer]` 行都保证带上 message 的开头（除非 message 自身超长，此时按既有规则截断并打 `...[truncated]`）。
- 来源被收短的行里会出现 `…(+Nch)`，这是来源被截的判据，不是页面 URL 里真的含这些字符。
