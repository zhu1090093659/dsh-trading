# 模型 API 模板(providers/)

每份 JSON 描述一家 **OpenAI 兼容的 Chat Completions 端点**(请求发往 `{base_url}/chat/completions`)。
页面里的直连对话、六阶段研究的「模型 API 大脑」、资料导入的 API 路径,用的都是这同一份模板。

- 模板只写**环境变量名**,永远不写真实 key。
- 本机订阅 Agent(Claude Code / Codex / WorkBuddy)**不用**这里的模板:它们用你自己在本机登录好的 CLI,模型由登录态决定。

## 字段

| 字段 | 含义 |
|---|---|
| `id` | 模板名,必须与文件名一致(`deepseek.json` → `deepseek`) |
| `name` | 界面上显示的名字 |
| `base_url` | Chat Completions 根地址;`null` = 模板不给,必须由用户填 |
| `env_key` | API key 所在的环境变量名(后台默认来源、命令行运行时按这个名字取 key) |
| `default_model` | 默认模型;`null` = 必须由用户填模型名 |
| `context_limit_tokens` | 上下文上限(可空) |
| `known_incompatibilities` | 这家已知的坑,写给人看 |
| `verified_at` | 地址与模型名最近一次按官方文档核对的日期;`null` = 没核对过 |
| `notes` | 备注 |
| `direct` | **产品的实测记录**(见下)。段名是 v1 留下的历史名 |
| `matrix` | v1 旧引擎的兼容矩阵记录,v2 不再使用 |

## 怎么用

**在页面里**:左侧栏「接入 AI」→ 选厂商、填 key(需要时改 Base URL 和模型名)。
这份配置只存在当前浏览器里(localStorage),不写进仓库、后端配置、日志或研究产物;共用电脑用完请清除。

**后台默认来源**(命令行运行、或由 Agent 替你部署时):

1. 设环境变量,如 `export DEEPSEEK_API_KEY=...`;
2. 在 `<数据根>/config.json`(默认 `.local/config.json`)里写 `{"provider": {"profile": "deepseek"}, "defaults": {"model": "deepseek-flash"}}`,
   或设环境变量 `VRA_PROVIDER=deepseek`;还没有这份配置时也可以用 `scripts/init --provider deepseek` 生成
   (已有配置时 init 不改它;`--force` 会先备份再整份重写)。

**先跑兼容矩阵再正式用**:

```bash
node orchestrator/src/finance/provider_matrix.ts --provider deepseek
```

对模板指向的端点真跑 10 个小回合(文本、工具调用、连续工具调用、并行工具调用、工具失败自修复、长输出、工具后收尾、服务端 schema、多轮上下文、图片输入),
结果写到 `.local/provider-matrix/<id>/<时间>/`(不含 key),并给出 `direct` 段的建议值。**不会自动改模板**,确认后自己写进覆盖模板。

## 「实测」与「未实测」

- **没有 `direct` 段 = 没实测**:照样能用,结构化要求写进提示词,产物仍由产品自己的校验把关;界面与运行记录(`manifest.provider.matrix_status = "untested"`)如实标「未实测」。
- `direct.supported: true` = 实测可用;`structured_output: "server_schema"` 时请求会带 `response_format`(JSON Schema 约束),`"prompt"` 时写进提示词。
- `direct.supported: false` = 实测不可用,产品拒绝接入(这和「没测过」是两回事)。

⚠️ 截至 2026-10-07,产品自带的模板**全部是「未实测」**:地址和模型名当天按各家官方文档核对过,但还没有用真实 key 跑过研究全流程。用之前先跑一遍上面的矩阵。

## 模板硬约束(`validateProfile`)

- `base_url`:远程必须 HTTPS;明文 HTTP 只允许 `localhost` / `127.0.0.1` / `[::1]`;地址里不能带用户名密码、查询参数或 `#` 片段(凭据填到 API key)。
- 地址里的占位符(如 `{WorkspaceId}`)必须换成你自己的值:在界面的 Base URL 里填,或写进覆盖模板。
- `env_key`:大写字母开头、只含大写字母数字下划线,不能借用 `PATH` / `HOME` 等系统变量名。
- `verified_at` 为 `YYYY-MM-DD` 或 `null`。
- v1 的旧引擎字段(`wire_api`、`auth_modes`、`responses_support`、`http_headers` 等)在旧覆盖模板里**仍能加载,但一律不用**。

## 用户覆盖与新增厂商

把模板复制到 `<数据根>/providers/<id>.json`(默认 `.local/providers/`)再改,同结构、优先级高于产品模板。
例如:MiMo Token Plan 订阅换地址、阿里云百炼换业务空间专属域名、给自托管服务改端口;也可以按同样结构新增一家。
不想写文件,也可以在「接入 AI」里选「其它 OpenAI 兼容端点」直接填 Base URL、key 和模型名(这种来源始终按「未实测」处理)。

## 产品自带模板(2026-10-07 按官方文档核对)

| id | 默认模型 | key 变量 | 要点 |
|---|---|---|---|
| `deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY` | 思考模式默认开;带工具时历史思考内容必须原样回传(产品已处理) |
| `glm` | `glm-5.3` | `ZAI_API_KEY` | v2 起直接走智谱官方地址 |
| `kimi` | `kimi-k3` | `MOONSHOT_API_KEY` | 产品不传推理强度 ⇒ 按默认 max 跑,更准但更慢、更费 token |
| `mimo` | `mimo-v2.6-flash` | `MIMO_API_KEY` | v2.5 系列 2026-10-21 下线;Token Plan 订阅要换地址 |
| `openai-api` | `gpt-5.4` | `OPENAI_API_KEY` | v2 起改名(旧 id `openai` 停用,写了会报错指路);从 GPT-5.4 起 Chat Completions 只在推理强度 none 时能调工具;要用推理模型请改选「Codex 订阅」 |
| `qwen` | `qwen3.8-max` | `DASHSCOPE_API_KEY` | 北京地域通用域名;key 分地域 |
| `selfhosted` | (留空,自己填) | `SELFHOSTED_API_KEY` | Ollama 默认地址;模型必须支持 function calling |

每家的完整说明(来源、其他模型、地域地址)见对应 JSON 里的 `notes` 与 `known_incompatibilities`。
国产模型各自单独进矩阵,不当成同一种「OpenAI 兼容」。
