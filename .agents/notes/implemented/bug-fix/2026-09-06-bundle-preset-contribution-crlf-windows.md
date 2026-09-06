# bundle getPresetContribution CRLF 归一——修 Windows runner 行定位失配

- **日期**: 2026-09-06
- **状态**: implemented

## 现象

v0.1.4 desktop-release 管线 windows-latest job 的 Test workspace 步骤失败：
packages/crypto installer.test「Missing crypto capability rows」
（src/index.ts:11 throw）。macos-latest 同 run 通过；v0.1.0–v0.1.3 的
Windows Test workspace 均绿。

## 归因

f8f794e 把四个市场 bundle 的 installer 从自安装机制（184 行）重写为薄
preset-contribution 提供者（26 行），行定位用
asset.indexOf('- id: ...
')——以 LF 锚定。仓库无 .gitattributes，Windows
runner 检出（autocrlf）把 assets/preset/*/agent.cordis.yml 转成 CRLF 后
needle 永不命中；macOS/Linux 检出 LF 不受影响。旧机制不做行尾锚定搜索，
故历史版本在 Windows 通过。四个 bundle（crypto/cn/hk/us）同款新写法，
同病。

## 修复

四个 bundle 的 getPresetContribution 读取后统一 replace(/\r\n/g, '\n')
再定位与切片；交给 base/presets 的 traderRows 恒为 LF。crypto 单测通过；
cn/hk/us 无 test script（由 kit/base 测试间接覆盖），修复同构。

## 管线处置

GitHub Release 未创建（github-release job 因 windows 失败 skipped），
按同 tag 修复重推规则处理：删除远端 v0.1.4 重打重推；npm-publish 幂等跳过
已发布包，无重发风险。
