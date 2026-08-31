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
  │    V2 bili_transcribe.js（无官方字幕时云端ASR，断点续传；无云端凭据时用同目录 whisper_asr.py 本地替代）
  │    V3 bili_transcript.py → 字幕文稿 → download/
  ├─ 微信文章链接 ─────→ 文章管线 A1
  │    A1 wechat_fetch.py（正文提取 → article_text.txt）
  └─ 共享分析层（素材就绪后，两类来源完全一致）
       S1 事实核查（web-search，三档标注）
       S2 五维深度报告（读 references/analysis-framework.md，调用 docx/pdf skill）
       S3 知识卡片沉淀
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

- 工作目录建议 `<任务根>/bili_<BV号后4位>/`（本机任务根例：`/Users/zcl/cowork/trading_journal/outputs/content_insight_<日期>/`），脚本自动创建。
- 读末行 `RESULT: {...}` 决定分支：`SUBTITLES_FOUND`（已有 subtitles.json，跳到V3）/
  `AUDIO_CHUNKED`（走V2）/ `FAILED`（视频不存在/VIP需登录/ffmpeg缺失，如实告知用户）。
- 已内置：cookie预热防412、WBI签名、b23.tv短链解析、多P选择（`--page N`）、durl老格式回退。

### V2: ASR 转写（仅当无官方字幕）

```bash
node <skill目录>/scripts/bili_transcribe.js <工作目录>
```

- 预期耗时：每29秒段约10-20秒（含8秒防限流间隔），**不要因慢而中断**。
- 断点续传：中断/失败直接重跑同一命令，已完成段自动跳过；重复运行直到
  `RESULT: {"status": "TRANSCRIBE_DONE"}`。
- ASR 有同音字误差（如"沃什/沃师"），分析时按上下文推断，文稿保留说明行。
- `--limit N` 仅用于冒烟验证，正式交付不要用。

### V2 备选：本机离线转写（云端凭据不可用时）

触发条件：`bili_transcribe.js` 报 `Cannot find module .../z-ai-web-dev-sdk`（脚本回退路径硬编码在另一台 Linux 机）或 `Configuration file not found`（缺 `.z-ai-config`，本机无 Z.ai API key）。此时用同一工作目录结构和输出协议的离线替代：

```bash
# 一次性环境准备（.venv 建在工作目录，不污染 skill 与系统 Python）
uv venv <工作目录>/.venv --python 3.12
uv pip install --python <工作目录>/.venv/bin/python mlx-whisper

# 转写（输出 <工作目录>/transcript_full.json + transcript_full.txt，V3 零改动直接消费）
<工作目录>/.venv/bin/python <skill目录>/scripts/whisper_asr.py <工作目录>
```

- 模型 `mlx-community/whisper-large-v3-turbo`（约1.6GB）首次运行时下载；HF 直连失败时设
  `HF_ENDPOINT=https://hf-mirror.com` 重跑。
- 整段 `audio.wav` 原子转写（比逐29s块上下文完整、时间戳更准）；工作目录已存在
  `transcript_full.json` 即自动跳过。Apple Silicon 上约20分钟音频约4分钟跑完。
- 同音字误差仍存在，需要人工修正（实测："美委"写成"美美"、"成住坏空"写成"沉/筑坏空"、
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

## 故障排查

| 症状 | 原因与处置 |
|------|-----------|
| B站 view API -404 | BV号错误或视频已删除，与用户确认 |
| B站 playurl -404/-352 | 需登录/VIP或风控，告知无法在未登录环境处理 |
| 音频下载 403 | 流地址过期（有时效），重跑 bili_fetch.py |
| ASR 大量 429 | 限流正常现象，脚本已退避；整轮失败等2分钟重跑续传 |
| bili_transcribe.js 报 Cannot find module / Configuration file not found | 本机无云端 SDK 凭据，改用 V2 备选 whisper_asr.py 本地转写 |
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
