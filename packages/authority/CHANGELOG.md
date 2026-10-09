# @dshtrading/authority

## 0.6.1

### Patch Changes

- Windows 可移植性修复：桌面构建在 windows-latest 上恢复。

  - **authority（属主隔离按平台能力判定）**：属主/权限这一层的前提是 POSIX 语义。Windows 上 `process.geteuid` 不存在，`fs.Stats.uid` 恒为 0、`mode` 按只读属性合成——「平面归另一个 uid」没有可比对的证据。新增 `hasUidSemantics()` 与 `uidSemantics` 选项，能力不成立即 `no-uid-semantics`，与是否注入 `euid` 无关。修正前注入 `euid` 会把合成 stat 当真属主，得出 `group-or-other-writable` 这类假阳性结论（把「不知道」说成某个具体判定）；不注入时读取端已 fail-closed，写入侧也在同码先抛，故生产路径并未放行，缺陷在「注入即改口」。该层此前从未在 Windows 上跑过：`pnpm -r test` 遇首个失败包即中止，排在它前面的 `dsh-home` 一直先红，把它整段遮住。
  - **base（Office 接线用例按本平台算期望值）**：`path.resolve('/opt/dsh-primary-runtime')` 在 Windows 上会按当前盘符补成 `D:\opt\dsh-primary-runtime`；把 POSIX 结果写成跨平台事实会让该用例在 windows-latest 判红。承接前一条：authority 修好后 base 成为首个失败包。

  发布意图：0.6.0 的 npm 包已公开但桌面构建在 Windows 失败，GitHub Release 因 all-or-nothing 未创建；本版本把 Windows 修复与已发布的 0.6.0 内容一起补齐，以新版本号发布完整 Release。

  - @dshtrading/dsh-home@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/dsh-home@0.6.0
