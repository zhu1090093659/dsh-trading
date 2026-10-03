---
name: content-insight
description: 提取并总结 B 站视频或微信公众号文章；转写、深度报告和知识库入库按用户请求选择。其他网站使用当前可用的网页读取工具。
---

# 内容深度分析与知识沉淀（B站视频 / 微信文章）

本技能封装一条经过实战验证的管线。核心设计：**素材获取层按来源分流，分析沉淀层全源共享**。
视频与文章的难点不同——B站是"AI字幕接口未登录态返回空，必须做好ASR回退"；
微信是"反爬风控频率性拦截，头部指纹必须完整+冷却重试"。这些坑都已在脚本中处理。

## 流程总览

```
用户输入 → 路由判断素材类型
  ├─ B站视频链接/BV号 ──→ 视频管线 V1-V3
  │    V1 bili_fetch.py（元数据+字幕尝试+音频下载+29s分段）
  │    V2 whisper_asr.py（无官方字幕时本地 mlx-whisper 转写，断点续传）
  │    V3 bili_transcript.py → 字幕文稿 → download/
  ├─ 微信文章链接 ─────→ 文章管线 A1
  │    A1 wechat_fetch.py（正文提取 → article_text.txt）
  └─ 共享分析层（素材就绪后，两类来源完全一致）
       S1 事实核查（web-search，三档标注）
       S2 五维深度报告（读 references/analysis-framework.md，按当前可用文档工具生成）
       S3 知识卡片沉淀
       S4 知识库入库（仅用户明确要求入库时执行）
```

## 路由规则

| 用户输入特征 | 走法 |
|--------------|------|
| bilibili.com / b23.tv / BV号 | 视频管线 V1-V3 |
| mp.weixin.qq.com/s/... | 文章管线 A1 |
| 同一请求混多源（如"对比这个视频和这篇文章"） | 分别取材，共享分析层做对比框架 |
| 其他网站链接 | 超出本技能范围，使用当前可用的网页读取工具 |

---

## 视频管线（B站）

### V1: 一键获取素材

```bash
python <skill目录>/scripts/bili_fetch.py "<视频链接或BV号>" <工作目录>
```

- 工作目录建议 `<任务根>/bili_<BV号后4位>/`，脚本自动创建。
- 读末行 `RESULT: {...}` 决定分支：`SUBTITLES_FOUND`（已有 subtitles.json，跳到V3）/
  `AUDIO_CHUNKED`（走V2）/ `FAILED`（视频不存在/VIP需登录/ffmpeg缺失，如实告知用户）。
- 已内置：cookie预热防412、WBI签名、b23.tv短链解析、多P选择（`--page N`）、durl老格式回退。

### V2: 本地 ASR 转写（仅当无官方字幕）

一次性环境准备（`.venv` 建在工作目录，不污染 skill 与系统 Python）：

```bash
uv venv <工作目录>/.venv --python 3.12
uv pip install --python <工作目录>/.venv/bin/python mlx-whisper
```

转写：

```bash
<工作目录>/.venv/bin/python <skill目录>/scripts/whisper_asr.py <工作目录>
```

- 模型 `mlx-community/whisper-large-v3-turbo`（约1.6GB）首次运行时下载；HF 直连失败时设
  `HF_ENDPOINT=https://hf-mirror.com` 重跑。
- 预期耗时：Apple Silicon 上约20分钟音频约4分钟跑完（83分钟视频约15-20分钟），**不要因慢而中断**。
- 断点续传：工作目录已存在 `transcript_full.json` 即自动跳过（整段原子完成）；失败直接重跑同一命令。
- 整段 `audio.wav` 原子转写（比逐29s块上下文完整、时间戳更准）；输出
  `transcript_full.json + transcript_full.txt`，V3 零改动直接消费。
- 同音字误差需人工修正（实测："美委"写成"美美"、"成住坏空"写成"沉/筑坏空"、
  片尾 BGM 会产出幻觉乱码段），引用原文前按上下文改写，必要时回听原视频。

### V3: 字幕文稿交付

```bash
python <skill目录>/scripts/bili_transcript.py <工作目录> \
  --output "<任务根>/download/视频字幕文稿_<主题关键词>.txt"
```

文件名用描述性中文。即使只需口头回答，也建议落一份文稿——它是后续分析的引用底稿。

---

## 文章管线（微信公众号）

### A1: 正文提取

```bash
python <skill目录>/scripts/wechat_fetch.py "<文章链接>" <工作目录>
```

- 工作目录建议 `<任务根>/wx_<短标识>/`。
- 读末行 `RESULT: {...}`：`ARTICLE_FETCHED`（含 title/account/publish_time/chars）/
  `FAILED`（含 error 与建议）。
- 脚本已内置反爬策略：**完整桌面浏览器头**（头部指纹不全会被拦；手机UA会跳验证码，
  两者都已实测）→ cookie预热重试 → 冷却90秒重试。
- 产物：`article_text.txt`（纯文本底稿，段落结构完整，图片以`[图片N]`占位）、
  `article.json`（元数据+图片URL列表）、`article.html`（原始页面备查）。
- 图片型文章（正文极短、图多）会在 RESULT 中体现 chars 与 images 数——
  此时提示用户：正文以图表为主，纯文本分析覆盖有限，可选下载关键图片用视觉模型解读。
- 若用户想要全文底稿交付：复制 article_text.txt →
  `download/文章全文_<主题关键词>.txt`（可选步骤）。

---

## 共享分析层（素材就绪后）

### S1: 事实核查（观点类内容必做；纯娱乐/纯文学可跳过）

读底稿（transcript_full.txt 或 article_text.txt），提取关键声称（数字、事件时间、
人物头衔、直接引用、独家性声称），逐条 web-search 核实（中文+英文各搜一次），
每条三档标注：✅证实 / ⚠️有出入 / ❓无法核实。搜索结果存 JSON 备查。
详细清单与操作准则见 `references/analysis-framework.md` 第二节。

### S2: 深度分析报告（仅用户要求深度报告时）

**先读 `references/analysis-framework.md`**（五维分析框架+报告模板），再按用户确认的格式：
- 默认 Word 时先加载官方 `office-docx` 技能，按其规范用 `load_workspace_dependencies` 返回的 Python（python-docx）生成，
  保存到 `download/深度分析报告_<主题>.docx`；用户指定 PPT 用 `office-pptx`，PDF 用该技能正文里的 LibreOffice Kit 路径转换。
  这些官方技能与依赖工具在当前部署不可用（未提供 primary-runtime 载荷）时，如实说明限制，不自造工具名、不搜索系统 Office、不安装替代方案。
- 报告第1节"内容基本信息"按来源取字段：视频→UP主/时长/链接；文章→公众号/作者/发布时间。
- 篇幅基准：5-10分钟视频或3000字内文章 → 2000-3000字正文；核查表至少覆盖5-8条关键声称。
- 生成后按所用文档工具的质检流程校验，无错误才交付。

### S3: 知识卡片

按 `references/analysis-framework.md` 第三节模板产出 `知识卡片_<主题>.md` 到 download/。
用户只要轻量总结时：视频=V3文稿+知识卡片，文章=可选全文底稿+知识卡片，跳过深度报告。

---

## S4: 知识库入库（仅明确入库请求）

普通总结、底稿或知识卡片交付**不触发入库**。只有用户明确要求写入知识库（"入库/沉淀到知识库/存进 cards"）时才执行本节；生成 Markdown 卡片不等于已入库，也不等于有写入授权。

**权威存储**：`$DSH_HOME/knowledge/cards.json`（dsh-trading 缺省 `~/.dsh-trading/knowledge/cards.json`）是知识库 UI 的数据源；字段契约与受控词表对齐 `knowledge-curation` 技能（source.url 为查重键；credibility 三档；factCheck 三桶；takeaways/boundaries/tags）。

### 入库流程（单条与批量一致）
1. 只调用 `knowledge_ingest` 工具逐张入库（自动 URL 查重、保持 ID 稳定）；
2. 工具不可用（如报 `store.list is not a function`：会话绑定旧构建或实例未重载）→ **停止入库**，保存待导入的 Markdown 卡片并报告失败原因；不直接读改写 `cards.json`——store 在 dsh 进程内有内存缓存，直写会被后续 flush 覆盖，一次读改写不等于并发安全；
3. 入库后自检：通过知识库工具读回核对（summary 非空、coreClaims 非空、credibility 枚举、URL 无重复），不能只用本地 JSON.parse 代替服务读回；
4. 不擅自重启 dsh 实例；如需重载让新卡片可见，报告给用户处理。

### 批量任务（用户明确批量入库时）
- 逐条入库、逐条读回校验；
- 完成后输出对账：应入库 N / 实际 N / 跳过（已存在）M / 失败清单及可重试输入。

---

## 故障排查

| 症状 | 原因与处置 |
|------|-----------|
| B站 view API -404 | BV号错误或视频已删除，与用户确认 |
| B站 playurl -404/-352 | 需登录/VIP或风控，告知无法在未登录环境处理 |
| 音频下载 403 | 流地址过期（有时效），重跑 bili_fetch.py |
| knowledge_ingest 报 store.list is not a function | 会话绑定了旧构建或 dsh 进程未重载：报告失败并保留待导入卡片，不直写 cards.json、不擅自重启 |
| knowledge_search 看不到新入库卡片 | 先确认入库是否真正通过工具完成；store 内存缓存问题报告用户，由用户决定是否重载实例 |
| whisper 模型下载失败（HF 直连超时） | 设 `HF_ENDPOINT=https://hf-mirror.com` 重跑 |
| mlx-whisper 安装或运行失败 | 本脚本依赖 MLX，仅支持 Apple Silicon；其他平台需另配本地 ASR（如 faster-whisper）后再跑 |
| 微信"环境异常"三次重试仍拦截 | 风控冷却未结束，等5-10分钟重跑；或请用户粘贴正文；或试 agent-browser |
| 微信"文章已删除/违规" | 无法获取，如实告知 |
| 微信正文过短且图片多 | 图片型文章，提示用户可选图片解读路径 |
| ffmpeg 不存在 | `apt install -y ffmpeg`（macOS: `brew install ffmpeg`）后重跑 |
| 转写空段 | 片头曲/纯音乐无语音属正常，保留空段不影响时间轴 |

## 明确的边界

- B站需登录态内容（充电专属、VIP正片）、直播流（live.bilibili.com）不在范围内。
- 微信付费文章、需要验证的内容无法获取，不要反复重试浪费配额。
- 遵守分析立场红线（`references/analysis-framework.md` 第四节）：区分转述与背书、
  数字必须溯源、不做动机审判。