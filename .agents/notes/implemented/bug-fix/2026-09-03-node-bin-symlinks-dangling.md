# Agent Note: 桌面包内 node bin 符号链接悬空（cpSync 重写绝对路径）

Status: implemented

## Problem

v0.1.0 macOS 安装包内，内置 Node 运行时的 bin/npm、bin/npx、bin/corepack 是
悬空符号链接，指向打包机的临时目录（/private/var/folders/.../T/dsh-node-*）。
用户侧实测：`xattr -cr` 遍历时对悬空链接报 "No such file" 且非零退出，导致
Release notes 里的 `xattr -cr … && open …` 放行命令在 && 处中断、open 不执行；
内置 npm/npx/corepack 一律不可用。

## Decision

- 根因：fetch-node.mjs 与 after-pack.cjs 都用
  `fs.cpSync(src, dest, { dereference: true })` 复制 node 发行版，而当前
  Node 的 cpSync 对符号链接的实际行为是「把链接目标解析成绝对路径后重建链接」
  （不是拷贝内容），目标指向解压用的临时目录。
- 修复：两个脚本改为显式 copyTreePreservingSymlinks——按 lstat 逐项拷贝，
  符号链接 readlink 后 verbatim 重建。官方 node 发行版的 bin 链接本就是相对
  形式（bin/npm -> ../lib/node_modules/...），verbatim 拷贝后在新位置天然正确。
- afterPack 校验器扩展：node 目录允许携带符号链接，但必须相对且在 .app 内
  可解析，否则构建即失败（此前只检查 host/profile-trading，node 目录被豁免，
  本 bug 因此漏网）。
- 本地端到端验证：重新 fetch-node 后 staged 链接全部相对可解析；内置 node
  实跑 npm-cli --version = 11.19.0；electron-builder --dir 打出的 .app 内
  xattr -cr 退出码 0、三链接全部可解析。

## Alternatives considered

- **cpSync + verbatimSymlinks: true**：等价于 verbatim 拷贝，但该选项仅较新
  Node 支持（desktop 工具链跨机器跑在任意 Node 22/24 上），自写 12 行拷贝
  函数不依赖版本行为，放弃。
- **发布时把三个链接替换为实体文件**：npm-cli.js 内部按自身位置 require，
  拷到 bin/ 后模块解析破裂，放弃。
- **只改 release notes 的放行命令（&& 改 ;）**：治标不治本，悬空链接本身
  仍是缺陷（内置 npm 不可用），放弃。

## Consequences

- 已发布的 v0.1.0 mac 安装包携带此缺陷（win 安装包不受影响：win 发行版的
  npm/npx 是实体 .cmd 文件）；修复进 main 后，下一次桌面发版（重推 v0.1.0 或
  发 v0.1.1，取决于届时是否有其他累积修复）自动带上。
- afterPack 新校验对 node 目录的符号链接是硬门禁，后续若 node 发行版布局
  变化会立即在打包阶段暴露，不会再静默发出悬空链接。
