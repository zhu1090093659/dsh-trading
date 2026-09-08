---
name: content-insight
description: 多源内容深度分析与知识沉淀技能，支持两类素材：① B站视频（bilibili.com / b23.tv / BV号）→ 官方字幕获取或音频ASR转写；② 微信公众号文章（mp.weixin.qq.com）→ 正文与元数据提取。统一产出：字幕/正文底稿、事实核查报告（三档标注）、五维深度分析报告（docx/pdf）、知识卡片。当用户给出B站视频链接并提出"总结/分析/提取字幕/转写/这个视频讲了什么"，或给出微信公众号文章链接并提出"总结/分析/这篇文章说了什么/帮我读一下/提炼要点/沉淀成笔记"时，务必使用本技能——即使用户没有明确提到"转写""字幕"或"分析"两个字。只要是B站视频或微信文章链接加任何形式的内容提炼诉求，就用本技能；其他网站的网页内容请改用 web-reader 技能。
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
       S2 五维深度报告（读 references/analysis-framework.md，调用 docx/pdf skill）
       S3 知识卡片沉淀
       S4 知识库入库（cards.json 统一存储，默认执行）
```

## 路由规则

| 用户输入特征 | 走法 |
|--------------|------|
| bilibili.com / b23.tv / BV号 | 视频管线 V1-V3 |
| mp.weixin.qq.com/s/... | 文章管线 A1 |
| 同一请求混多源（如"对比这个视频和这篇文章"） | 分别取材，共享分析层做对比框架 |
| 其他网站链接 | 超出本技能范围，改用 web-reader 技能 |

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

### S2: 深度分析报告

**先读 `references/analysis-framework.md`**（五维分析框架+报告模板），再按用户确认的格式：
- 默认 Word：**必须先调用 docx skill** 按其规范生成，保存到
  `download/深度分析报告_<主题>.docx`；用户指定 PDF/PPT 时调用对应 skill。
- 报告第1节"内容基本信息"按来源取字段：视频→UP主/时长/链接；文章→公众号/作者/发布时间。
- 篇幅基准：5-10分钟视频或3000字内文章 → 2000-3000字正文；核查表至少覆盖5-8条关键声称。
- 生成后运行 docx skill 的 postcheck 质检，0 errors 才交付。

### S3: 知识卡片

按 `references/analysis-framework.md` 第三节模板产出 `知识卡片_<主题>.md` 到 download/。
用户只要轻量总结时：视频=V3文稿+知识卡片，文章=可选全文底稿+知识卡片，跳过深度报告。

---

## S4: 知识库入库（统一存储，默认执行）

**唯一权威存储**：`~/.dsh/knowledge/cards.json` —— dsh-trading 知识库 UI（中栏知识库 Tab）的
唯一数据源。markdown 知识卡片（S3 产物）只是过程底稿；**不入库 = 未沉淀**。
字段契约与受控词表对齐 dsh-trading 的 `knowledge-curation` 技能（source.url 为查重键；
credibility 三档；factCheck 三桶；takeaways/boundaries/tags）。

### 默认流程（单条与批量一致）
1. 优先调用 `knowledge_ingest` 工具逐张入库（自动 URL 查重、保持 ID 稳定）；
2. 工具不可用（如报 `store.list is not a function`：会话绑定的是修复前旧构建，或
   dsh-trading 未重启）→ 走**直写回退**（见下）；
3. 入库后必须自检：重新 `JSON.parse` 校验 + 抽查字段完整性（summary 非空、coreClaims
   非空、credibility 枚举、URL 无重复）；
4. **直写后必须提醒用户**：store 在 dsh 进程内有内存缓存（启动时读一次），
   直写对活进程不可见且会被后续 flush 覆盖——需重启 dsh 实例（如 trading-web）后生效，
   并避免在重启前从旧进程再触发 ingest。

### 直写回退协议（工具不可用时）
- 备份：`cp cards.json cards.json.bak-<批次名>`；
- 按既有卡片 schema 追加（id 格式 `kc_<hex>`，createdAt/updatedAt ISO 时间戳）；
- 原子性：一次性读改写；若怀疑有活跃 store 实例，先提示重启再做；
- markdown → 字段映射：核心观点/核心论点与推理链→coreClaims（注意兼容编号列表）；
  ✅/⚠️/❓ 三类行→factCheck 三桶；可复用视角/框架→takeaways；适用边界→boundaries；
  tags 用主题聚类标签 + 作者名，词表外标签需说明理由。

### 批量任务（系列视频/合集沉淀）
- 逐条转换、逐条校验，不允许只写 markdown 不入库；
- 全量完成后输出对账：应入库 N / 实际 N / 跳过（已存在）M / 失败清单。
- 深度解析类（长视频）必须带事实核查三桶；纯卡片类可空桶。

---

## 故障排查

| 症状 | 原因与处置 |
|------|-----------|
| B站 view API -404 | BV号错误或视频已删除，与用户确认 |
| B站 playurl -404/-352 | 需登录/VIP或风控，告知无法在未登录环境处理 |
| 音频下载 403 | 流地址过期（有时效），重跑 bili_fetch.py |
| knowledge_ingest 报 store.list is not a function | 会话绑定了旧构建或 dsh 进程未重载：重建 dsh-trading 后重启实例；批量任务用 S4 直写回退协议 |
| knowledge_search 看不到刚直写的卡片 | store 进程内存缓存所致，重启 dsh 实例后可见；直写前先备份 |
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