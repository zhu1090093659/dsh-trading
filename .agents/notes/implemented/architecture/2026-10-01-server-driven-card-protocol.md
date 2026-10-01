# 服务端驱动卡片协议：封闭枚举、可机检不退化规则、硬上限棘轮

日期：2026-10-01 · 阶段：P4 步骤 2 · 卡片：bf92b5d2 · 包：`@dshtrading/contract/cards`

## 事实

- **三份封闭词汇各 12 项**：CardType（desk-summary / risk-state / decision / trigger-trace / position / order / mandate-status / escalation / journal-gap / freshness / control-panel / system-notice）、FieldKind（含 `enum`、**没有 html/template/raw 逃生口**）、ActionKind（ack…revoke-device）。
- **四条"不退化"规则全部可机检**（`validateCard`）：① 三类枚举必须封闭，**未知值 ⇒ 卡片不可操作（禁用全部 Action）**；② `enum` 字段必须带非空 values 且值在其中；③ `fallbackText` 必填非空；④ 控制类动作必须 `confirm: true`（kill/pause/flatten 不允许一键触发）。
- **12 项硬上限是棘轮**（`CARD_LIMITS`）：超限**判为非法，不做截断** —— 截断会把"超限"变成静默降级，用户看到的是一张"看起来正常"的残缺卡片。
- **两个渲染出口**：`renderableActions(card, caps)` 在卡片非法或含未知枚举时返回**空数组**；`fallbackFor(card)` 在不可渲染时明说"请升级客户端"，而不是假装正常。
- **观测面不依赖 tick 流**：新鲜度由卡片上的 `freshnessMs` 字段表达（呼应卡片步骤 3 的要求）。

## 测试（30 例全绿，本轮新增 15 例）

三类词汇各 12 且唯一；未知 cardType 非法不可操作；未知 fieldKind/actionKind ⇒ 不可操作；enum 值越界或缺 values ⇒ 不可操作；fallbackText 必填；控制类动作缺 confirm ⇒ 不可操作；协议无 html 逃生口；revision 必须非负有限；**六个上限逐个超限都被拒**；体积上限；上限表 12 项且关键值冻结；不可操作卡片零 Action 下发；caps 过滤；兜底文本升级提示。纯函数，无 mock 无 sleep。

## 测试抓出的一处设计不一致（已修，值得记）

体积上限那条例题原本用"24 个字段 × 256 字符"构造，结果**达不到 `maxCardBytes`** —— 也就是说字段级上限加起来也撑不到 16KB：**体积上限真正防的是无界的 `display`（open 扩展）**，而不是字段。例题改走 `display` 之后才真正触发。这条如果不写测试，`maxCardBytes` 会成为一个"看起来在防什么、其实防不到"的摆设。

## 未验证项（如实标注）

- **渲染实现未做**：本步只落地协议与校验；网页 SPA / 移动 App 的实际渲染在步骤 3/4。
- **12 个上限的取值没有实测依据**：它们是**设计上限**（防止单卡撑爆客户端），不是从真实卡片样本标定出来的——与 P3 的"三个上界必须标定"不同，那些参数影响正确性，这些只是防御性边界。如果后续有真实卡片样本，应该按样本重新标定并只降不升。
- **caps 的粒度是 `action:<kind>`**，与步骤 1 的 `X-Dsht-Caps` 尚未在真实请求上联调。

## 被否决的方案

- **未知枚举按"尽力渲染"处理**：用户会以为自己看到的是全部，而实际上按钮被静默吞掉。
- **超限截断**：把"超限"变成静默降级；判非法更诚实（服务端应当分页/裁剪后再发）。
- **下发 HTML/模板/布局 DSL**：客户端会变成远端代码执行器，且移动端无法保证渲染一致性。
- **控制类动作不要求二次确认**：kill/flatten 一键触发是事故的常见起点。
