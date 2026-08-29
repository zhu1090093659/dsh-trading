# Task B 证据：kit-crypto 真实实现 + crypto-trader preset 自安装 + bundle 行调整

时间：2026-08-29 ｜ 执行：impl-b 子 agent ｜ 全部验证 0 模型调用、0 harness 依赖（node 直驱构建产物）。

## 结论

| 项 | 结果 | 证据 |
|---|---|---|
| `pnpm -r build` | ✅ 全绿（5 包） | 末节 |
| crypto_funding_rate 真实网络 | ✅ 真实 Binance 数据 | `obs/task-b-verification.json` fundingRate 节 |
| preset 自安装幂等（两次运行第二次零写入） | ✅ run A `wrote=[agent.cordis.yml,preset.yml]`，run B `wrote=[]` | 同上 selfInstallRunA/B 节 |
| apply() 接线 | ✅ providers=1、tools=crypto_funding_rate、fire-and-forget 自安装日志「nothing — already current」 | 同上 apply 节 |
| 安装字节 = 打包资产 | ✅ 两文件 sha 相等 | 同上 byteEquality 节 |
| preset 格式对照官方 standard | ✅ 3 行（persona + connector + kit）；persona 写法/`{{model}}`/`{{cwd}}` 同官方；preset.yml `{name,description,order}`；无审批/沙箱/模型路由行 | 本文件「格式自查」节 |
| 负例 fail-closed | ✅ `../etc/passwd` → invalid symbol 拒绝 | 同上 negativeSymbol 节 |

## 真实网络验证（fapi.binance.com，2026-08-29）

```
crypto_funding_rate BTCUSDT — last 3 funding event(s):
- 2026-08-28T16:00:00.001Z  rate=0.00005913 (0.0059%)  markPrice=78308.90000000
- 2026-08-29T00:00:00.000Z  rate=0.00010000 (0.0100%)  markPrice=77806.12043478
- 2026-08-29T08:00:00.000Z  rate=0.00010000 (0.0100%)  markPrice=77597.93110145
```

独立 fetch（`GET https://fapi.binance.com/fapi/v1/fundingRate?symbol=…&limit=…`），不经 connector 服务，两包解耦。

## 复现命令

```sh
cd /Users/zcl/code/dsh-trading && pnpm -r build
rm -rf ~/.dsh-trading-presets/crypto-trader   # 可选：回到首次安装状态
node --import spikes/impl-b/verify/register-hook.mjs spikes/impl-b/verify/verify-task-b.mjs
```

`verify/host-peer-hook.mjs`：直驱构建产物时把宿主提供的 `@deepseek-ai/*` peer（dsh-scope/dsh-llm/dsh-session 等，pnpm `ignoreMissing` 不安装）只读映射到参考 checkout；子路径（如 `@deepseek-ai/dsh-llm/brand`）经包自身 exports 自引用解析。仅验证脚本使用，仓库布局零改动。

## preset 格式自查（对照官方 `@deepseek-ai/dsh-agent-presets` standard/）

1. 顶层 YAML 行列表，行 = `{id, name, config}`；preset 目录名 `crypto-trader` 合 `[a-z0-9][a-z0-9-]*`。
2. persona 行：`id: persona` + `@deepseek-ai/dsh-persona` + `config.text`（`>-` 折叠文本），与官方逐形一致；persona 插件要求 scoped context（preset 挂载即 agent scope）。
3. **isolate realm 判断**：connector/kit 两行只向 scope 分层注册表（`ctx.tools`/`ctx.skills`）注册、不 provide 服务 → 与官方 standard 的 tool-fs/tool-bash 同类，**无需 realm**（tools 注册表 ScopedLayers 按 scope 过滤，standard 会话看不到 crypto 工具）；此判断已写进 agent.cordis.yml 头注释，未来 service 行必须包 `group: true` + `isolate` 组行。
4. 不持有审批/沙箱/模型路由（host 面职责）；preset.yml 仅 `{name, description, order}` 展示元数据。
5. 两市场插件行 config 均带 `dryRun: true / liveTrading: false`（kit 的 Config schema 补齐同词汇键 + `presetRoot` 覆盖项）。

## 过程中的发现（入账）

1. **空 patch 必须写 `[]`**：`loadProfile → parsePatchList` 对非数组直接抛错（`packages/boot/app-boot/src/index.ts`），纯注释文件解析为 null 会崩掉 profile 加载。`packages/crypto/cordis.patch.yml` 已改为「注释 + `[]`」。
2. **可选工具参数不能写 `required: false`**：dsh-tools schema 编译器报 `UNSUPPORTED_SCHEMA: required must be true when present`（官方写法 = 直接省略键，如 tool-fs-search 的 `path`）；`default` 是受支持的 annotation 关键字。
3. tsdown unbundle 会把 peer 依赖解析成相对路径写死进 lib（kit-crypto/lib 内嵌 .pnpm 相对引用），直驱 node 时需 hook 补宿主 peer（见上）。

## 架构缺口（给主 agent / 下一轮验收）

- **自安装 bootstrap**：行已移出 bundle patch，kit 不再被 host 面挂载 → 自安装只在 crypto-trader preset 首次挂载时触发，而首次挂载又要求 preset 目录已存在（鸡生蛋）。切片验收前需要三选一：① base bundle 的统一 agent-presets 行 + 一次性种子（手工拷贝/CLI 触发一次 kit.apply）；② 保留一条 host 面挂载 kit 的行；③ 文档化「安装后先跑一次」。当前实现完全符合任务书（apply() 幂等自安装 + 卸载不删除），缺口留待统一验收决策。
- agent-presets 行需把 `~/.dsh-trading-presets` 配进 roots（统一配置归 base，本任务未动 base）。

## 改动文件

- `packages/crypto/cordis.patch.yml`：移除两行 insert（行移 preset 面），保留 insert-only 注释，空层 `[]`（附约束说明）。
- `packages/kit-crypto/src/index.ts`：crypto_funding_rate 工具（真实 API + 参数校验/钳制 + 渲染）；`installPreset()` 幂等自安装（mkdir -p + diff 写，卸载不删除）；Config（dryRun/liveTrading/presetRoot）；inject=['skills','tools']；skill provider 保留。
- `packages/kit-crypto/assets/preset/crypto-trader/{agent.cordis.yml,preset.yml}`：preset 资产。
- `spikes/impl-b/verify/*` + `obs/task-b-verification.json`：本证据。
