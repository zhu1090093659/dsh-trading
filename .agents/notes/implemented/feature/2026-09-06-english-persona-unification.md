# Agent Note: 预设注入文本统一英文——人设与宿主前缀同语言，回答跟随用户语言

Status: implemented

## Problem

轨迹面板里宿主身份前缀（"You are an AI agent powered by DeepSeek Harness…"）是英文，紧接着 dsh-trading 人设是中文（"你是「大师」…"），同一段系统提示词两种语言，认知割裂（owner 2026-09-06 截图反馈："很容易产生认知错位"）。owner 裁决：注入系统提示词的文本统一英文；回答语言跟随用户提问语言，不在提示词里写死中文。

## Decision

`packages/base/src/presets.ts` 注入文本全部英文化：四角色 `text`、DOCTRINE、EVIDENCE、JOURNAL、DELEGATE_RULE、市场清单后缀；后缀新增显式规则 `Always reply in the language the user writes in.`（委派子代理为 `Write your reply in the language of the task brief.`）。刻意不动：① preset.yml 的 name/description 保持中文——那是 GUI roster 的 UI 文案，不进系统提示词；② 技能资产（company-analysis、crypto-instrument-analysis 等）保持中文——它们是按需加载进对话的参考材料，不是系统提示词，且大量中文市场术语（涨跌停/T+1/供股）翻译有语义漂移风险；③ 旧版每市场 preset 文件的中文人设本就是切片丢弃的死内容。方法论铁律的语义与 2026-09-06 doctrine 定调逐条对应，仅换语言不换规则。测试断言锚点同步换成英文等价串。

## Alternatives considered

双语人设（英文身份句 + 中文规则段）：比纯中文更割裂，且缓存前缀更长，弃。连同技能资产一起英文化：技能体量近千行、术语漂移风险高，且属对话上下文而非系统提示词，owner 指令范围未覆盖，留作独立决策。

## Consequences

新会话 persona 与宿主前缀同语言，认知一致；回答仍跟随用户语言（显式规则保障中文用户不受影响）。托管预设由安装器在宿主启动时重写，trading-web profile 副本刷新 + 桌面壳重启后生效。验证：base 27 测试全绿；重写后的 `~/.dsh-trading-presets/*/agent.cordis.yml` persona 全文英文、含语言跟随句。锚点变更同步至 [2026-09-06-hypothesis-scarcity-doctrine.md](2026-09-06-hypothesis-scarcity-doctrine.md)。
