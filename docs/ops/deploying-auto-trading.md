# 部署自动交易能力（主仓侧接缝）

自动交易平面的**源码**在私有卫星仓 [dsh-trading-bot](https://github.com/zhu1090093659/dsh-trading-bot)，不在本仓。本仓保留的是**可部署能力**：把卫星仓打包出的产物放进来，桌面/服务端构建会把它们装配进 profile。

## 为什么是产物而不是子模块

主仓是公开仓。子模块（submodule）会把卫星仓的 URL 与每个 commit 写进公开历史，等于把私有仓的坐标与变更节奏一起公开；vendor tgz 只暴露「这里有个投放口」，不暴露内部结构。这也是本仓 client-ui-special-indicators 已有的做法。

## 怎么投放

在卫星仓里打包：

    pnpm -r build
    for p in bot bot-api tradectl cockpit contract; do
      pnpm --filter "@dshtrading/$p" pack --pack-destination ../../satellite-out
    done

把产物放进本仓的投放槽位（该目录 gitignore，任何时候都不入库）：

    mkdir -p desktop/satellite-vendor
    cp satellite-out/*.tgz desktop/satellite-vendor/

`DSH_SATELLITE_VENDOR` 可指向别处。构建时 desktop/scripts/build-runtime.mjs 的 adoptSatelliteTarballs 会：

1. 只采纳 SATELLITE_OWNED_PACKAGES 里的包（其余忽略）；
2. 把它们登记进 profile 的 dependencies 与 pnpm overrides；
3. 只把带 cordis.patch.yml 的两个（bot、bot-api）接进 bundles，其余是纯库依赖。

## 缺席会怎样

不投放时构建照常成功：主仓的辅助交易 profile 不装自动交易能力，pnpm gates:all 全绿。投放后才多出自动交易平面。**「能不能部署」由投放决定，「有没有源码」永远是否**。

## 边界由门禁守着

pnpm repo-boundary:check（scripts/repo-boundary-check.mjs）四条判据：

- BD1 主仓不得存在 packages/{bot,bot-api,tradectl,cockpit,contract} 实现目录
- BD2 不得出现这些包的源码级 import（注释与显式接缝声明放行）
- BD3 vendor 槽位只允许 .tgz，不允许解包目录
- BD4 被 git 跟踪的 tar 里不得含卫星包源码（防 git add --force 绕过 .gitignore）

BD4 的存在理由：槽位是「投放即可用」，而 .gitignore 挡不住 --force；产物里含自动交易源码，误提交就会进公开仓，所以判据落在「已跟踪的 tar 里有没有卫星包路径」而不是「槽位里有没有文件」。
