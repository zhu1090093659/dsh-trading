# Spike 评审清单（主 agent 复核用，2026-08-29）

评审原则：不信任报告的结论，只信任可复核的证据。每份 REPORT.md 按下表核对——报告声明的机制事实必须能在源码中找到对应（我已预核实的列为「已知 ground truth」）。

## 已知 ground truth（我已亲自核实，报告与此矛盾即打回）

- bundle 识别：package.json 的 `dsh.bundle.patch` 字段（packages/bundle/base/package.json）。
- profile 初始化：`dsh plugin --profile <新名> add` 自动初始化，初始 bundles=[@deepseek-ai/dsh-base]，patchReload:live，manifest 在 profile 的 package.json 的 `dsh.profile` 字段。
- 无 bundle 声明的包安装时有警告「installed as a plain dependency, not a profile layer」。
- patch 语义：按 id 整行替换 config（bundle/web-app/cordis.patch.yml 顶部注释）。
- preset 发现：roots 配置扫描（path+trust），`<dshHome>/.agent-presets` 用户 root，broken 行带原因列出。
- **schedule = 仅限会话内提醒**（schedule_create/list/delete 三工具，到期以会话消息送达，无服务接口、无对外通知）——**不构成交易后台自动化基座**，S4 若结论相反必有问题。自动化需另案设计（插件自管定时器+dispose / webhook / 外部 cron+headless）。
- approval = `ctx.approval.request(req)`（@deepseek-ai/dsh-user-approval），无应答者时 fail-closed 拒绝；应答者 = approval/request waterfall 监听器；有按会话策略。文档：docs/subsystems/approval.zh.md。
- credentials = `ctx.credentials`（存/取/删机密，配置按名引用）+ credentials-local 默认存储 + authorization flow；环境覆盖优先于存储值。BYOK 走这里。

## 逐 spike 验收点

### S1（树外 bundle 安装）PASS 要求
- [ ] spike-s1 profile 启动日志/builtins 证据显示 hello 插件行加载（非仅 pnpm 安装成功）
- [ ] patch 分层顺序证据：bundle patch 在 profile/home patch 之前应用
- [ ] remove 后 cordis.yml 无残留行
- [ ] 第二 bundle 并存无覆盖（insert-only 验证）
- [ ] 关键疑点追査：bundle 的 patch 里插件行的 name 解析（profile node_modules vs 安装闭包）

### S2（skill 随包）PASS 要求
- [ ] SkillProvider 契约引用（文件:行号）与 skill-badge 一致
- [ ] 会话目录出现 spike skill 的直接证据（目录持久化/会话记录/模型加载成功三者之一，说明选择理由）
- [ ] 卸载后消失的证据
- [ ] inject 依赖声明要求（provider 注册依赖 ctx.skills 服务存在）

### S3（preset root+自安装）PASS 要求
- [ ] roots 配置 patch 行的完整写法（含 default 等 restate 键）
- [ ] roster 出现 spike preset 的证据（选择器/服务/日志）
- [ ] 以该 preset 创建会话成功的证据（工具集符合 agent.cordis.yml）
- [ ] 自安装关键问题实测结论：新目录不重启能否被发现（可行/需重启/不可行）
- [ ] 卸载后 broken 行为记录

### S4（服务 API 调研）评审重点
- [ ] schedule 结论必须是「会话内提醒，非自动化基座」级；若给出服务 API 则查证
- [ ] approval 应给出 ctx.approval.request 的消费形态；检查 fail-closed 语义是否写明
- [ ] credentials 应给出 CredentialRef/CredentialKey 用法
- [ ] python 桥：subprocess/python 目录的消费路径与跨平台注意
- [ ] 每项 READY/NEEDS-SPIKE/RISKY 定级与证据匹配

### S5（包规范+脚手架）评审重点
- [ ] 「dsh plugin add 后如何被加载」链路描述与 S1 实测一致（交叉验证）
- [ ] 模板字段与官方包一致（main/exports/files/dsh.*）
- [ ] TEMPLATES.md 可直接落地（文件内容完整、无占位符）

## 打回处理
打回的 spike 用 send_message 把具体差异点发回对应执行会话（保留会话可继续），不推倒重跑。
