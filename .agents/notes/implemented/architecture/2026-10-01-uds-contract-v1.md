# UDS 契约 v1：长度前缀分帧、逐帧版本校验、inode 守卫与 freeze-risk

日期：2026-10-01 · 阶段：P2 步骤 3 · 卡片：21b6b892 · 包：`@dshtrading/tradectl/uds`

## 事实

- **分帧**：4 字节大端长度 + UTF-8 JSON（`encodeFrame` / `createFrameDecoder`）。选长度前缀而不是按行分帧：JSON 字符串里可以合法包含换行，按行分帧会在第一次遇到带换行的 payload 时静默错位。解码器是流式的——分片到达也能还原帧。
- **单帧上限** `DEFAULT_MAX_FRAME_BYTES` = 1MiB：帧长是对端给的数字，不设上限等于把内存交给对端；解码器在看到超长声明时立刻抛 `frame-too-large`，不先分配。
- **逐帧版本校验**：每帧都带 `protocolVersion`，不等于当前版本就抛 `protocol-version-mismatch`（带 code 的错误帧 + 关闭连接）。握手一次不够——连接是长命的，升级窗口里两端版本会不同；逐帧校验让不匹配表现为那一帧被明确拒绝，而不是被对端按错语义解析出一个看起来正常的结果。
- **归属与权限**：socket 目录 `0750`（组可进入不可写）、socket 文件 `0660`。已有同名文件时只删 `socket` 类型，其它类型一律拒绝（`socket-path-occupied`）——免得把真实文件当陈旧 socket 删掉。
- **inode 守卫**：绑定后记录 `dev/ino`；`checkIdentity()` 用 `lstat` 复核，文件消失或 inode 变了即 `freeze(reason)`：断开所有连接、不再处理新帧、**不自动重绑**。周期调度由调用方负责（测试直接调 `checkIdentity()`，不 sleep）。
- **调用方认证**：主机制是**继承 fd**。

## why（两条关键取舍）

1. **inode 变了为什么不自动重绑**：socket 文件被替换通常意味着有人在冒充执行核（把客户端引到假核上）。此时正确动作是冻结并停下，而不是悄悄重绑一个新 socket 让攻击者再换一次——自动重绑会把一次已检测到的事件变成静默恢复。
2. **为什么不做 uid 校验**：纯 Node 在 UDS server 侧没有 peer-credential API（`SO_PEERCRED` 需要原生扩展）。本轮**如实标注为未验证项**，没有用"路径权限看起来够"来假装等价——这正是设计文档 §13 说的"测不到的必须留证据，不许假装测过"。

## 演练记录（2026-10-01，真实 socket 文件与真实替换）

    1) 核心已绑定: /var/folders/.../uds-drill-Jj7DzR/core.sock
       身份 dev/ino = 16777229/175323585
    2) 正常往返: {"echoed":"status"}
    3) 发起方版本不符时的判定: {"ok":true}
    4) 有人把 socket 文件换成自己的: /var/folders/.../core.sock
    [core] FREEZE-RISK: socket inode changed (dev/ino 16777229/175323585 -> 16777229/175323586): someone replaced the core endpoint
    5) 守卫判定: {"ok":false,"reason":"replaced"}  冻结=true
    6) 冻结后核心是否重绑了 socket: 否（按契约不自动重绑）
    7) 冻结后原客户端: no-response
    8) 演练结束，临时目录已清理

## 测试（10 例，全绿）

分片到达还原、超长声明拒绝、非 JSON 报错、正常往返（服务端补齐版本）、版本不匹配被拒并关连接、目录 0750 与文件 0660、inode 替换 ⇒ replaced + 冻结 + 未重绑、文件消失 ⇒ missing + 冻结、身份未变不误报、冻结后连接被断开。全部真 socket 文件（临时目录），无 mock、无 sleep。

## 未验证项（如实标注）

- **uid/peer-credential 校验未实现**（纯 Node 无 API；如需，评估 DSH 树内 `node-addon-system-*` 并单独走一轮验证）。
- socket 目录的**组归属**（`chgrp` 到核心组）未在生产部署里验证——本地 drill 只有属主。
- 协议语义层（方法名、错误码、幂等）尚未定义：v1 目前只有帧层与版本契约，方法表归步骤 4/5 的调用方落地。

## 被否决的方案

- **按行分帧（NDJSON）**：payload 里的换行会静默错位。
- **握手时校验一次版本**：长连接 + 升级窗口 ⇒ 版本漂移无人发现。
- **inode 变化后自动重绑**：把攻击面变成"自动恢复"，见 why 1。
- **用路径权限冒充 uid 认证**：权限能挡住"别的用户写目录"，挡不住"同一用户下的另一个进程/被替换的 socket"，不做等价声明。
