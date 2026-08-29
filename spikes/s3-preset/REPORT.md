# S3 REPORT：第三方 bundle 给 agent-presets 配额外 root + 插件自安装 preset 被发现/挂载

- 结论：**PASS**（机制全链路 0 次模型调用，无 e2e 凭证依赖）
- Profile：`spike-s3`（专用 scratch）｜ Spike 包：`spike-preset-pkg`（bundle patch + plugin 同包）
- 时间：2026-08-29 15:05–15:25 CST ｜ 工作目录：`/Users/zcl/code/dsh-trading/spikes/s3-preset/`

## 结论

| 通过标准 | 结果 | 证据 |
|---|---|---|
| 第三方 bundle patch 给 agent-presets 配额外 root | ✅ | dump 组合树 `# == @spike-s3/preset-pkg` 层内 `id: agent-presets` 行含 `default: spike-s3-preset` + 自有 root（obs-dump.txt L342-348） |
| patch 整行替换语义（default 等必填键需 restate） | ✅ | 同 bundle 层先 insert vendor config（含 `/tmp/nonexistent-vendor-root-s3`）再按 id 覆盖，最终树中 vendor root **消失**、仅剩 spike root → 整份 config 替换、不合并 |
| 插件自安装 preset 目录被发现 | ✅ | 启动即幂等写入 `spike-presets/spike-s3-preset/`；roster 出现 `spike-s3-preset (trust=user)`；`resolve()` 返回其 `agent.cordis.yml` 路径（obs/roster-boot.json） |
| 会话可挂载 | ✅ | `agents.create({setup: async ctx => { await presets.mount(ctx, 'spike-s3-preset') }})` 成功（obs/mount-test.json `ok:true`）；preset 组合内 marker 行在 agent scope 内实际启动（obs/preset-row-applied.jsonl `[S3-MARKER]`），与会话挂载后行才运行的事实一致 |
| 不重启感知新增 preset 目录 | ✅ | 进程运行中 mkdir `spike-extra` → 2s 轮询 roster 内出现，无需任何重启（obs/roster-live.jsonl 07:18:06 行） |
| 卸载/损坏后 broken 行为 | ✅ | 删 `agent.cordis.yml` → broken「composition file agent.cordis.yml is missing — the directory still occupies the id」；行引用不存在包 → broken「row "bad" names a plugin that cannot be resolved: …」；删除目录 → 行消失。broken 行**跨进程重启仍在**（boot-idempotent 轮基线即含） |

**自安装路径实测结论：可行，且完全无需重启**——发现不记忆化，`list()`/`resolve()` 每次调用重扫全部 roots；插件在 `apply()` 里写文件即可，同进程后续任何会话都能看到并挂载。

## 关键证据（命令 + 输出摘录）

1. 安装（官方命令，同 S1 结论）：`dsh plugin --profile spike-s3 add 'file:…/spike-preset-pkg'` → bundles 自动追加；`add 'link:…/web-search-exa'` → 普通依赖警告（修 home 级 exa 悬空链接坑）。
2. `dsh --profile spike-s3 --dump-config`（obs-dump.txt）：
   ```
   # == @spike-s3/preset-pkg
   - id: spike-s3-observer
     name: '@spike-s3/preset-pkg'
   - id: agent-presets
     name: '@deepseek-ai/dsh-agent-presets'
     config:
       default: spike-s3-preset
       roots:
         - path: /Users/zcl/code/dsh-trading/spikes/s3-preset/spike-presets
           trust: user
   ```
3. boot 日志（obs/boot.log，exit 0、无任何错误行）：
   ```
   [S3] self-install spike-s3-preset at …/spike-presets/spike-s3-preset wrote=[agent.cordis.yml,preset.yml]
   [S3-MARKER] preset row applied inside a joined agent scope
   [S3-LIVE] roster: standard|broken=no ; ptc|broken=no ; minimal|broken=no ; cordis|broken=no ; spike-s3-preset|broken=no ; liangshen|broken=no
   ```
   roster 同时含随包 4 个（trust=system）+ 我 root 的 spike-s3-preset + `~/.dsh/.agent-presets` 的 liangshen（includeUserRoot 追加）——优先级/多 root 共存正确。
4. 未知 preset：`resolve('no-such-preset-xyz')` → `UnknownPresetError: preset "no-such-preset-xyz" not found (available: standard, ptc, minimal, cordis, spike-s3-preset, liangshen)`。
5. 幂等重装：二次 boot（不删目录）`wrote=[nothing — already current]`（obs/boot-idempotent.log）。

## 机制细节

### 文件格式（实测确认）

- **preset 目录**：目录名即 id（`[a-z0-9][a-z0-9-]*`）；必须含 `agent.cordis.yml`（顶层 YAML 插件行列表，行 = `{id?, name, config?…}`，组行 `group: true` + `isolate`）；可选 `preset.yml` 纯 YAML `{name, description, order}`（展示用，损坏不影响挂载）。本 spike 的最小可用组合仅 1 行（本包自己的 marker 插件），证明 preset 行解析以 profile node_modules 为基准。
- **patch 写法**（bundle 的 `cordis.patch.yml`，包需 `dsh.bundle.patch` 声明 + 把 `@deepseek-ai/dsh-agent-presets` 列入 dependencies 以进入 profile 安装闭包）：

  ```yaml
  - insert:                       # base/headless 层没有 agent-presets 行（在 web-app bundle 里），本层先补行
      - id: agent-presets
        name: '@deepseek-ai/dsh-agent-presets'
        config: { default: standard, roots: [{path: /tmp/vendor-root, trust: user}] }
  - id: agent-presets             # 整行替换（同文件后续 entry 亦可打先行 insert 的行）
    config:
      default: spike-s3-preset    # 必填键必须 restate
      roots:
        - path: /abs/path/to/root # 支持 ~ 展开；trust: system|user
          trust: user
  ```
  `includeShippedRoot`/`includeUserRoot` 省略时回落插件 schema 默认（均 true）；要纯自有 preset 集需显式 `false`（restatement 由部署自行决定）。
- **发现时机**：`list()`/`resolve()` 无缓存、每次实扫（discovery.ts 头注释 + index.ts「Discovery is unmemoized」）→ 新目录/损坏/删除都即时反映。
- **broken 语义**：目录占位但组合缺失/坏 YAML/形状错/行不可解析 → 带 reason 的 roster 行（不是隐藏）；`resolve()` 对 broken 仍成功（删除/报告需要它），挂载路径 `resolveMountable` 拒绝。健康检查不 import 任何插件（磁盘解析 + 形状检查），故「运行时才抛错」的行要到首个会话才炸。
- **挂载路径**：preset 组合挂为常驻子树（每 preset 一次），会话经 `agents.create` 的 `setup: async ctx => { await presets.mount(ctx, id) }` 认父加入——与 session-controller `composeAgent` 完全同路。注意 setup **必须 resolve 为 undefined**（返回值被当作 `{commit()}` 发布钩子调用）。
- **headless 适配**：headless bundle 明确声明不组 preset roster（模型行在 host 平面），需要 preset 的 headless 部署须自行按上述 join——本 spike 的 observer 插件即示范。

### 最可靠观察面（选择理由）

选「**自研 observer 插件进程内读 roster + 2s 轮询落盘 + 真实 `presets.mount` 挂载**」，而不是 Web GUI/API：headless profile 没有 Host/HTTP 面可用；roster 的真正消费方（session-controller、Web）最终都走同一个 `list()/resolve()/mount()` 服务面，进程内直接断言最短路径、0 模型调用、可定时采样（免重启感知用墙钟序列证明），且 boot 日志/JSON 落盘可留档复核。`--dump-config` 作为组合树（patch 层）的独立旁证。

## 发现的坑

1. **`file:` 依赖是安装时快照**：pnpm 在 `dsh plugin add` 时把目录拷进 profile node_modules，此后改源码不生效；须删掉 `node_modules/<pkg>` 再 `dsh plugin --profile X install` 重建。本 spike 的挂载测试第一次失败（`(intermediate value)?.commit is not a function`）一半是这个坑（一半是 setup 返回值问题），排障时先 diff 拷贝。
2. **`agents.create` 的 setup 返回值即发布钩子**：`setup: ctx => presets.mount(...)` 隐式返回 mount 的解析值 → 被调 `.commit()` 抛错。必须 `async ctx => { await presets.mount(...) }`。
3. base/headless 层**没有** agent-presets 行（它在 web-app bundle patch 里）；第三方 bundle 在 headless 场景要么自己 insert 该行，要么假设部署已含。patch 打不存在的行只是 Loader 警告不致命，容易静默落空。
4. 多 root 共存正确（shipped/system 前置、配置 roots、`~/.dsh/.agent-presets` user 后置），但 README 已知限制成立：非第一个 user root 下的 preset 可发现却不可删除（authoring 限定第一个 user root）。
5. home 级 patch 对所有 profile 生效（exa 行），新 profile 必须自带 `link:` 依赖，否则启动即崩（复用 S1 结论，本次主动规避）。

## 对正式实现的建议

1. dsh-trading 市场插件可在自己的 bundle patch 里 insert/覆盖 `agent-presets` 行：`default` 指向市场自带 preset id，roots 指向「市场 preset 仓库目录」（建议放 `<repo>/presets/` 并用绝对路径或 `~` 展开；trust 用 `user`）。若宿主是 web-app（行已存在）用 id 覆盖整行 + 全键 restatement；若宿主 headless 需先 insert 行。
2. 插件启动时幂等自安装 preset 到该 root 完全可行且免重启：`mkdir -p` + 内容 diff 后写（本包 `selfInstall()` 可直接搬）。**不要**写进 `~/.dsh/.agent-presets`（与用户创作区混居，且会被 user 默认值/删除逻辑牵连）；用市场自有 root 更干净。
3. preset 组合的行解析以 profile 安装闭包为基准（挂载时 bare 包名从 harness baseUrl 解析）：市场 preset 引用的插件必须进市场 bundle 的 dependencies，否则整行被标 broken。
4. 发布/升级市场 preset 时注意「代际以 agent.cordis.yml stamp 为键」：改文件即对新会话生效（免重启），但 skill/资产旁文件改动要等组合文件本身变动；升级后旧的常驻挂载代际不回收（进程生命周期内）。
5. 打包分发若走 npm，留意 `file:` 快照坑不存在于正式安装流；但开发调试用 file:/link: 时改码必须重装。

## 附：产物清单

- `spike-preset-pkg/`（package.json + cordis.patch.yml + index.js）
- `obs-dump.txt`（组合树）、`obs/boot.log`、`obs/boot-idempotent.log`、`obs/roster-boot.json`、`obs/mount-test.json`、`obs/roster-live.jsonl`、`obs/preset-row-applied.jsonl`
- `spike-presets/spike-s3-preset/`（自安装产物：agent.cordis.yml + preset.yml）、`spike-presets/spike-broken-*`（broken 样本）
