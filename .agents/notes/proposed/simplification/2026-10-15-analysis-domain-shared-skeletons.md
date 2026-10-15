# Agent Note: 分析域的同形段：kit 的 skill-provider 骨架与九个文件版 store 适配器

Status: proposed

## Problem

两处「同一段骨架抄 N 遍」的实现面，都在活跃路径上：

- **六个市场 kit 加 base 的 skill-provider 段**。`packages/kit-cn/src/index.ts:153-166` 与
  `packages/kit-futures/src/index.ts:141-154` 的 `providerForSkills` 主体去空白后逐字节相同
  （实测为 true）；`Config` schema 段同样——kit-cn `138-144`、kit-futures `128-134`、
  kit-hk `135-141`、kit-us `133-139`、kit-global `129-135` 五份去空白后是**同一个哈希**
  （含那段「`Schema.array()` 会把缺席归一成 `[]`」的坑注释）。第七份语义在
  `packages/base/src/role-skills.ts:75-88`。六段合计约 880 行，其中 kit-cn / hk / us /
  futures / global 五段（各约 129–131 行）几乎逐字相同；kit-crypto 那一段更长（约 233 行），
  有实质差异。
- **九个文件版 store 适配器**。`packages/dsh-home/src/store-transaction.ts` 已经拥有原语
  （`:37 SKIP_WRITE`、`:68 transactStore`、`:129 createStoreCache`，另有 `TransactStoreOptions`
  与 `StoreCache` 两个接口），其上是同一套「读盘 → 事务写 → 落盘成功后发布缓存」骨架
  被各包各写一遍：`indicators/custom-fs.ts`、`indicators/chart-activations-fs.ts`、
  `strategies/custom-screener-fs.ts`、`strategies/builtin-tombstones-fs.ts`、
  `knowledge/knowledge-fs.ts`、`holdings/store-fs.ts`、`watchlist/file-store.ts`
  （逐个实测均同时引用 `transactStore` 与 `createStoreCache`）。其中
  `holdings/store-fs.ts` 专门写了一段注释解释「为何不能提前 publish」，说明这条纪律
  现在有九个复述点。

## Proposal

两件事分开推进，共同的红线是「只收敛与市场/领域无关的骨架，领域形状留在包内」：

1. **抽一个 `skill-provider` 工厂**（放 `packages/base/src/role-skills.ts`，它已经拥有这份语义），
   吸收：白名单三态（缺席 = 全量、显式 `[]` = 空面、未知名 fail-fast）、`Config` schema 段、
   注册骨架。各包保留：候选清单、`resourceBase` / locator、工具面，以及 kit-futures 那条
   「少提供一项即 apply 期 fail-fast」的契约。
2. **抽一个「记录 store 适配器」工厂**。位置需要裁决：`dsh-home` 是市场无关基础设施包，
   把「记录 store」这个概念塞进去会让它承担领域形状知识；备选是新建一个薄包，
   或让工厂只接受 `readFromDisk` / `encode` / `decode` 三个回调、不碰任何领域类型。
   九个 store 各自不同的部分必须原样保留：knowledge 的作者别名归一、chart-activations 的
   `sanitizeInstance`、holdings 的形状校验、tombstones 的 `Set` 形态、watchlist 的多文件形态。

## Context & Efficiency Impact

- 可省代码：skill 段约 650–780 行（kit-crypto 那份不并入）、store 适配器骨架约 600 行。
- 改点收敛：白名单三态语义与那条 schema 坑注释现在有 7 个改点，收到 1 处；
  「锁内新鲜读盘 + 只有落盘成功才发布缓存」这条纪律从 9 个复述点收到 1 处。
- 无模型可见面变化：工具名、参数、输出形状都不动。

## Alternatives considered

- **把六份同形当作刻意的市场隔离层，什么都不做**：本提案不排除这个结论，但需要 owner 明确裁决，
  因为现状是「隔离」与「抄写」无法区分——同形段里没有任何一处是市场特有的。
  若裁决为隔离层，本记录降为只记录，不再推进。
- **把 kit-crypto 那份也并进来**：否决。它比其余五份长约 100 行且内容有实质差异，
  强行统一会把 crypto 特有的部分变成工厂的可选分支。
- **把 store 工厂放进 `dsh-home`**：存疑。它已是市场无关基础设施包，但「记录 store」是领域概念；
  更小的一步是工厂只收三个回调、不引入任何领域类型，位置仍留在 `dsh-home`。
- **不动骨架、只把九个 `readFromDisk` 抽成共享**：否决。九个 `readFromDisk` 恰恰是**真有差异**的那部分
  （别名归一 / sanitize / 形状校验 / Set / 多文件），抽它等于把领域逻辑集中到错误的层。

## Verification & Gates

- skill 工厂：`pnpm --filter @dshtrading/base test`、六个 kit 各自的 `test`（现有
  `base/test/role-skills.test.ts` 与 kit-{futures,global,crypto}/test/skills.test.ts 已把三态契约钉住，
  收敛后这些用例必须原样通过），外加一条「未知名 fail-fast」的负向用例。
- store 工厂：九个包各自的 `test`（含 holdings 的 `store-fs` 并发用例）全绿；
  另加一条「落盘失败时不发布缓存」的负向用例，把那条被复述了九次的纪律钉在一处。
- 收口：`pnpm build` 与 `pnpm gates:all`。

## Risks

- skill 面是宿主加载期路径：`providerForSkills` 的行为变化会以「会话建不起来」或
  「工具不可见」的形式暴露，而不是测试红。收敛后必须按六包各自的 `cordis.patch.yml`
  与 preset 行做一次真实加载验证。
- store 面牵着用户数据：九个 store 的坏 JSON / ENOENT 降级口径目前各写一份，
  合并时必须逐个确认口径一致再统一，不能按「看起来一样」合并。
- 本提案与既定的「多市场对称是刻意重复」约束存在张力，推进前需要 owner 先裁决该约束
  是否覆盖 kit 之间的**市场无关**同形段。
