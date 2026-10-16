# Agent Note: 桌面壳 macOS 代码签名与 TCC 身份

Status: implemented

## Problem

桌面壳的 macOS 产物一直是 ad-hoc（上游 Electron 的 linker 签名：`Signature=adhoc`、
`TeamIdentifier=not set`、designated requirement 只锚 `cdhash`）。而 embedded 模式下
Computer Use 的 TCC 授权按**宿主应用**记账——工具自报 "Embedded mode: status reflects
the HOST app's TCC grant"，交易壳里的宿主进程就属于 `DSH Trading.app`。cdhash 每次重建
都变，于是「辅助功能 / 屏幕录制」的授权在每次重建后失效：交易壳内 agent 实测只剩
`list_windows`、`get_accessibility_tree` 这类免 TCC 的只读调用可用，`get_window_state`
的截图与 `click` / `type_text` 的像素路径一律被系统拒绝，`ui-screenshot-verify` 的标准
手法（原生截图 + `verify_state` 断言）在壳内跑不通。

## Decision

`desktop/` 的 macOS 打包默认按**钥匙串里自动发现的签名身份**签名（本机落到
`Apple Development: 1090093659@qq.com`，团队 `3H4FK5CBYJ`），带 hardened runtime 与
`resources/entitlements.mac.plist`。签名后壳的身份是：`Identifier=com.dsh-trading.desktop`、
`TeamIdentifier=3H4FK5CBYJ`、`flags=0x10000(runtime)`、DR 为 `identifier + anchor apple
generic + certificate leaf[subject.CN]` —— 跨重建稳定，TCC 授权因此可以保留。

三件事必须由代码保证，不能靠约定：

1. **交给 codesign 的必须是指纹**（`scripts/sign-mac.cjs`）。electron-builder 的内置路径
   最终执行 `codesign --sign "<证书通用名>"`（`macPackager.doSign` 用 `identity.name`
   覆盖 hash），而本机钥匙串里有两张同名 Apple Development 证书，通用名必然 `ambiguous`。
   自定义 `mac.sign` hook 重新枚举身份，按 `mac.identity` / `CSC_NAME`（证书全名或
   SHA-1）收敛到唯一一张，只把指纹交给 `@electron/osx-sign`；选不中即 fail closed，
   并打印候选清单与覆盖命令。
2. **`mac.identity` 不写 `null`**：`MacTargetHelper.handleNullIdentity` 会整条关掉签名。
   留空时的解析顺序是 `mac.identity -> CSC_NAME -> 钥匙串自动发现`；钥匙串里没有可用
   身份时 `findSigningIdentity` 返回 null、`macPackager.sign()` 随即 `return false`
   （不调用 sign hook），产物仍是可启动的未签名包——CI runner 上没有证书，走的正是
   这条路径。
3. **未签名不得静默**（`scripts/mac-signing-guard.cjs`）。配了 `mac.sign` 之后
   electron-builder 自己的「找不到签名身份」告警被吞掉（`noIdentity = !config.sign &&
   identity == null`），由 `afterAllArtifactBuild` 兜底：未签名且无人声明签名材料时打
   显式横幅；声明了材料却没签成、Developer ID 签名缺 hardened runtime、凭据齐备却没有
   公证票据，三种情况判红。

时间戳策略：`@electron/osx-sign` 默认给每个被签文件加 `--timestamp`，本仓载荷约 4.1 万个
文件（其中上千个二进制），一次性几百次 TSA 往返会被 Apple 限流并以 "The timestamp
service is not available" 中断构建。非公证构建因此默认 `--timestamp=none`；凭据齐备要
走公证时保持 osx-sign 默认（Apple 要求安全时间戳），`DSH_MAC_TIMESTAMP=default|<TSA URL>`
可显式覆盖。

公证与分发是可选分支：`mac.notarize: true` 只在 `APPLE_*` 齐备时生效（与
`MacTargetHelper.getNotarizeOptions` 同一套三选一判定）；凭据齐备却选了非 Developer ID
身份时 `sign-mac.cjs` 提前报错；`.dmg` 的公证 + staple 由 `afterAllArtifactBuild` 补
（electron-builder 只公证 `.app`）。

entitlements 以 app-builder-lib 自带三项为底（allow-jit、allow-unsigned-executable-memory、
disable-library-validation），不追加 `com.apple.security.automation.apple-events`：
`desktop/src` 壳不驱动其他 App（只有 spawn 自带 Node 运行时与 Windows 下的 taskkill），
要加就必须同时补 Info.plist 的 `NSAppleEventsUsageDescription`——测试里有成对断言的守卫。

## Consequences

- 本机（或任何钥匙串里有可用 Apple Development 证书的机器）跑 `npx electron-builder --mac`
  直接出带 hardened runtime 的开发签名包；钥匙串里没有可用身份时，产物与本决策前一致
  （ad-hoc、可启动、启动后由横幅点名），不会因为 `hardenedRuntime: true` 变成起不来的包。
  身份可用 `CSC_NAME=<SHA-1>` 固定，避免同名证书落到另一张。
- 开发签名仍过不了 Gatekeeper（`spctl -a -t exec` rejected），对外分发照旧需要
  Developer ID Application + 公证；那一步要付费账号与公证凭据，尚未落地。
- **TCC 授权是人工步骤，签名不代替它**：授权对象是 `/Applications/DSH Trading.app`
  这个身份，必须在「系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制」里手动加入；
  embedded 模式下驱动不会主动弹窗。签名保证的是这条授权今后跨重建保留。
- **CI 发布产物仍不签名**：桌面 release 构建出来的壳与本地构建的身份不同，只有本机
  构建的壳带稳定 TCC 身份。用户 2026-10-16 决定放弃 Developer ID/公证路线，相应地
  `.github/workflows/` 回到 HEAD（未签名约定不变）。
- 本仓 harness 会话的环境带 `ELECTRON_RUN_AS_NODE=1`，直接用它拉起 Electron 会被当成
  Node 跑并立即退出；手工验证壳时用 `env -u ELECTRON_RUN_AS_NODE open -a ...` 或
  `--user-data-dir` 隔离单实例锁。

## Alternatives considered

- **Developer ID Application + 公证（分发级）**：能让下载即开，但需要付费 Apple Developer
  Program、导出证书、创建 ASC API Key 并把它们注入 CI secrets。用户 2026-10-16 明确
  放弃（"太麻烦了"）。已写好的配置与 CI 接线半成品归档在 `.local/desktop-signing-ci/`
  （`desktop-release-signing.patch` + `desktop-signing-check.yml`）：恢复时按 patch 重放，
  并在 `desktop-release.yml` 注入 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_*`。
- **自签证书**：完全不依赖 Apple 账号、可签 10 年，但要在本机装一个自签信任根，且自签
  anchor 能否被 TCC 接受未实测；在已有 Apple Development 证书的前提下收益为负。
- **维持 ad-hoc，每次重建后手动重勾授权**：零仓库改动，但每次重建都要人工重来，且
  cdhash 身份在 TCC 列表里是易失条目——这正是本决策要消除的成本。
- **只公证不签名**：不成立，公证的对象就是 Developer ID 签名产物。

## Testing

- `npm --prefix desktop test`：`desktop/tests/mac-signing.test.mjs` 14 条用例覆盖身份解析与
  收敛（重名按指纹唯一化）、时间戳策略、公证前提校验、签名形态分类与判定矩阵；
  `pnpm test:audit` 通过且零新增测试债。
- 沙箱实测（`cp -Rc` 克隆到 /tmp，不动仓内 `desktop/dist`）：真签名后 `codesign -dvv` 为
  `Identifier=com.dsh-trading.desktop` / `TeamIdentifier=3H4FK5CBYJ` / `flags=0x10000(runtime)`
  / DR 锚 team+cert，`codesign --verify --deep --strict` 退出 0（资源封印覆盖 41,373 个
  文件），签名包与未签名包都能启动并渲染交易 GUI。
- 本机换装实测：`/Applications/DSH Trading.app` 由 `Identifier=Electron / adhoc /
  TeamIdentifier=not set` 换成上面的签名身份，装后 `codesign --verify --deep --strict`
  退出 0。
- 未验：Developer ID 身份下的签名形态、公证与 staple（本机无凭据）；自签证书的 TCC
  接受度；授权补齐后壳内 Computer Use 的端到端复跑（等人工授权）。
