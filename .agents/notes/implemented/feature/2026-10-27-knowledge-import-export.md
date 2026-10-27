# Agent Note: 知识库 bundle 导入导出（跨用户共享单文件）

Status: implemented

## Problem

知识库（`packages/knowledge`，本机 `~/.dsh-trading/knowledge/cards.json`）从 2026-08-31 落地起只服务单机：卡片由 agent 经 `knowledge_ingest` 入库，视图只读呈现，数据不上传也不同步。于是"我看过的观点"无法交给另一个人：把 `cards.json` 整个拷走会连带覆盖对方的库，逐张手抄又不现实。项目所有者 2026-10-27 提出知识共享需求，要求做成导入导出。

两条现成口径约束了做法：去重键是 `source.url`（`knowledge-fs.getByUrl` 与 `validateKnowledgeCard` 都按它判重），且 `knowledge_delete` 证明"删卡要连带清理 `related` 悬空引用"——共享必须保住卡片之间的显式关联，否则对方拿到的是散卡。同时仓库已有两条同类先例可对齐：`importWatchlists` / `importChartActivations` 的「HTTP 200 + ok:false + reason」缺 store 口径，以及写路由必须声明 `invalidates` 的结构守卫。

## Decision

- **载体是单文件 bundle，格式只有一个家**：`packages/knowledge/src/bundle.ts` 的 `createKnowledgeBundle` / `serializeKnowledgeBundle` / `parseKnowledgeBundle` / `planKnowledgeImport` 全是纯函数，浏览器与 node 同构。文件形状为 `{ meta: { schemaVersion: 1, exportedAt, cardCount, generator, notice }, cards: KnowledgeCard[] }`；`meta.notice` 随文件写明"第三方观点的结构化转述，不构成投资建议"。桥、视图与两个 agent 工具都调这四个函数，没有第二份解析。
- **读宽容、写严格**：`meta.cardCount` 与实际不符不拦（手改与工具截断常见），但 `schemaVersion` 不是 1、卡片缺 `id` / `title` / `source.url`、非 JSON、超上限一律点名报错——导入的是别人给的数据，静默降级等于把脏数据写进库。
- **上限两侧同口径**：单文件 ≤ 2000 张卡且 ≤ 8 MiB（`KNOWLEDGE_BUNDLE_MAX_CARDS` / `KNOWLEDGE_BUNDLE_MAX_BYTES`，字节数用 `TextEncoder` 计——中文卡片的 UTF-8 字节数远大于字符数）。导入超限 400 点名；导出侧判同一组常量，超限不落文件、提示先缩小筛选范围，避免造出一个自己都导不回来的文件。
- **去重与覆盖语义**：`source.url` 为键。`skip`（默认）保持本机卡片原样并进 `skipped`；`overwrite` 用文件内容改写，但保留本机 `id` 与 `createdAt`、只刷新 `updatedAt` 与内容——别人一份旧版本不该改掉你的卡片身份。
- **身份映射保住关联**：新建卡片保留对方 id；id 已被本机占用、已被本批更早的卡占用、或已被映射表 from 侧占用时重生成并记 `remappedIds`。`related` 先按映射表改写（含"本机已有同 url 但 id 不同"的卡片），再按「本地 id ∪ 本批待写 id」过滤，指向未随包导出卡片的引用丢弃并按卡片汇总进 `droppedRelated`；过滤后的引用仍全部过 `validateKnowledgeCard`。
- **预览与写库同源**：视图用 `planKnowledgeImport(本机卡片, bundle.cards, mode)` 算预览（新增 / 更新 / 跳过 / 丢弃关联 / 非法），确认后把**原始文件文本**交给桥，host 读库用同一函数重算再写。计划永远是"库里此刻的事实"，不是客户端那份可能过期的快照。
- **三个入口**：主机工具 `knowledge_export`（`path` 省略则落 `$DSH_HOME/knowledge/exports/`，可按 tags / sourceType / credibility / cluster 过滤）与 `knowledge_import`（`path` + `mode` + `dryRun`）；桥写路由 `POST /knowledge/import`（`invalidates: ['knowledge']`，`BridgeInvalidateStore` 相应加 `'knowledge'`，零写入不动 store，`saveMany` 存在则一次落盘）；知识库视图工具栏的导出（当前筛选结果，空结果禁用）与导入（选文件 → 预览 → 确认 → 重拉）。
- **失败口径沿用同类先例**：请求侧问题走 `BridgeProtocolError` → `{ ok:false, code, message }`；宿主未挂知识卡 store 走 `HTTP 200 + ok:false + reason`（与 `importKnowledge` / `importChartActivations` / `importWatchlists` 一致）；客户端把 `error` → `reason` → `message` → `HTTP <status>` 依次回落成一句可展示文案。

## 验证证据

- `packages/knowledge`：`vitest run` 10 文件 / 87 例全绿，其中 `bundle.test.ts` 23 例（往返、空库、字节与卡数上限、`schemaVersion` 不符、缺字段点名、`meta.cardCount` 不符宽容、skip/overwrite、id 重映射三源、关联改写与丢弃、非法条目不中断其它卡）、`import-tools.test.ts` 9 例（过滤导出、默认路径、不可写路径、dryRun 不写库、skip/overwrite 落库、非法 mode 与空白 path）。
- `packages/bot-api`：`knowledge-import.test.ts` 10 例 + `bridge-invalidation.test.ts` 30 例（含 `POST /knowledge/import` 的失效声明与拒绝样本）全绿；`tsc --noEmit` exit 0。
- `packages/client-ui-knowledge`：`import-export.test.ts` 6 例（文件名补零、导出文本可被同一解析器读回、空库可再导入、两模式计划计数、非法文件原文错误）；`i18n-audit --check` exit 0（16 个 `kv.io.*` 键 zh/en 齐平，后补 `kv.io.exportTooLarge` 共 17 个）。
- 完整门禁与桌面壳往返证据见本变更的交付说明。

## Alternatives considered

- **NDJSON（每行一张卡）**：落选——大库 diff 友好，但与现有 `cards.json` 数组形状不同构，视图与工具都要多一层解析，"格式只有一个家"当场破掉。
- **纯卡片数组（与 `cards.json` 完全同构）**：落选——省掉一层外壳，但没有版本位，格式演进只能靠猜，也带不出导出时间、卡片数与免责声明。
- **导入整表覆盖 `cards.json`**：落选——对方一份文件就能抹掉本机所有卡片与核查结论，且无法只共享一个主题簇。
- **默认覆盖同 url 的卡片**：落选——静默改掉本机已有的核查结论，比"少导入几张"代价大得多；覆盖做成显式选项。
- **覆盖时重生成 id**：落选——同一张卡在两边来回导入会反复换 id，引用关系与历史分析里的卡片标注全部失效。
- **导入直接写库（不做预览）**：落选——别人文件里的内容落库不可逆（只能事后逐卡删），写前看到"新增 N / 跳过 M"的成本远低于误导入。
- **只做 CLI / 工具，不动 UI**：落选——"把文件发给另一个人"这件事本身就发生在图形界面里。
- **导出时脱敏作者名与原文链接**：落选——`source.url` 是去重键、作者是查证锚点，脱敏后既不能查重也不能核验；隐私边界改为"导出是显式用户动作"并在 §7 写明。

## Consequences

- 知识库的隐私边界从"只在本机、不出门"改为"本地为唯一真源，导出是显式用户动作"；`docs/design/knowledge-graph.md` §3 增加 bundle 契约、§7 与 §8 同步改写。
- `BridgeInvalidateStore` 值域扩到 `'knowledge'`，客户端 SSE 早就有 `knowledge` 处理器，写成功即刷新视图，无需新增信号通道。
- 两个新工具进入工具契约冻结清单（`scripts/tool-contract-freeze.json`），改名或改必填参数会红。
- 已知限制：导出文件名精确到秒，同秒两次导出后者覆盖前者（浏览器下载目录语义）；视图的导入面板只有进场动画、无退场；写库期间 header 的关闭按钮与 Esc 仍可关面板（写库照常完成、卡片照常重拉，只是看不到结果提示）；导出侧的字节上限只在点击时判定（渲染期只用"卡片数 > 2000"这一条便宜条件，避免每帧序列化全库）。
