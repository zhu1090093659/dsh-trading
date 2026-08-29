# Agent Note: 交易所连接器模板化接入（template + generator + playbook）

Status: implemented

## Problem

OKX 接入完成后（connector-okx，第一个真实 TradeService），「接一个新交易所」仍是一件
高认知成本的事：包结构、命名契约（插件名/行 id/工具名/服务键）、三段闸门语义、凭证 ref
解析、互斥激活注册面、preset isolate 组、单位与错误码坑——这些在 okx 切片中都踩实了，
但没有任何一处把它们当作「可复制的标准」固化。直接复制 connector-okx 源码会被 OKX
特有代码（签名体系、instId 词汇、ctVal 换算、错误码表）污染，删改成本高于重写；
而复制手册（docs/replication.md）只覆盖「市场复制」维度，不含「市场内加交易所」维度。

## Decision

新增三件套，把「接入新交易所」变成模板化流程：

1. **packages/connector-template**：可编译可测试的连接器脚手架包。结构真实
   （Config/闸门/凭证解析/注册面/apply 全部就位且导出），交换所特有逻辑（签名、端点、
   字段解析、错误码、单位换算）以 TODO 保留，每处 TODO 指回 connector-okx 的准确
   参照段。包名用合法的 `@dsh-trading/connector-template`，token 未展开也可编译
   （占位符均标识符安全形态）；**不入任何 bundle 依赖**，仅作脚手架源。
2. **scripts/new-connector.mjs**：生成器。从模板复制并以 token 展开
   （__EXCHANGE_SLUG__/__EXCHANGE__/__ENV_PREFIX__/__MARKET__/__MARKET_CAP__），
   package.json name 与目录 slug 强制一致；目标目录存在默认拒绝；任何未替换 token
   收尾报错终止——不可能产出半展开包。
3. **docs/connector-playbook.md**：交易所接入手册。一张图列全要动的文件、模板填写
   顺序表（7 项 TODO 对照 OKX 参照段）、命名契约对照表、preset 接线规范、测试与
   验收 R 序列、坑清单（含复制手册外的交易所维度坑）。

模板冒烟测试 7 用例仅守卫结构性正确性（Config 默认面/闸门三态/凭证 ref 分组/
互斥激活注册面/dry-run 不触网），实现级测试属生成后的新连接器自身职责。

## Alternatives considered

- **直接复制 connector-okx 再改**：否决。OKX 特有代码占 70%+，逐段删改的认知成本与
  出错面远高于从干净骨架填写；且会带回 OKX 的错误语义（如 51400 幂等化）污染新所。
- **只写手册不写模板**：否决。手册能列清单，但「结构正确性」需要一段可编译的基准
  （闸门顺序、凭证 ref 语义、注册面 duplicate-safe 都是踩过坑的），纯文档守不住。
- **模板做成可运行 demo（假交易所）**：否决。会让模板与真实连接器的「必须实现的
  关键点」集合偏移，且假端点/假签名很容易被当作可提交状态。

## Consequences

- 新交易所接入成本从「研究+结构设计」降为「生成 + 按清单填 TODO + 测试」；
- 模板本身进入 `pnpm -r build/test` 基线（现 17 包），模板损坏会立刻红；
- 生成器与手册依赖 connector-okx 作为「红宝书」——okx 若拆解/大改，手册 §2 参照表
  要同步（这是有意的单一参照系选择，避免多参照漂移）；
- 未做：模板校验器（生成结果 lint/结构断言除冒烟外不强校验），若未来新连接器频出
  可加生成后检查脚本。
