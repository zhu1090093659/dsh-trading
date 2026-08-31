#!/usr/bin/env python3
"""whisper_asr.py — 本地 mlx-whisper 转写（content-insight 管线的离线 ASR 替代）

用于 bili_transcribe.js 的云端 SDK 在本机不可用时（无 .z-ai-config 凭据）。

依赖（Apple Silicon，一次性）:
    uv venv <工作目录>/.venv --python 3.12
    uv pip install --python <工作目录>/.venv/bin/python mlx-whisper

用法: <工作目录>/.venv/bin/python whisper_asr.py <工作目录> [...更多工作目录]
输入: <工作目录>/audio.wav
输出: <工作目录>/transcript_full.json [{index, start:"HH:MM:SS", text}] + transcript_full.txt
      （与 bili_transcribe.js 输出格式一致，bili_transcript.py 可直接消费）
模型 mlx-community/whisper-large-v3-turbo（约1.6GB）首次运行时下载；
HF 直连失败时设 HF_ENDPOINT=https://hf-mirror.com 重跑。
已存在 transcript_full.json 的工作目录自动跳过（断点语义：整段原子完成）。
同音字误差需人工修正（如"美委"→"美美"、"成住坏空"→"沉/筑坏空"），引用前按上下文改写。
"""
import json
import sys
from pathlib import Path

import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"
INITIAL_PROMPT = "以下是普通话财经内容，可能涉及美联储、沃什、加息、美债、通胀、黄金、美股、A股等话题。"


def fmt_ts(t: float) -> str:
    h, m, s = int(t // 3600), int(t % 3600 // 60), int(t % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def transcribe_one(wd: Path) -> None:
    out_json = wd / "transcript_full.json"
    if out_json.exists():
        print(f"SKIP {wd.name}: transcript_full.json 已存在", flush=True)
        return
    audio = wd / "audio.wav"
    if not audio.exists():
        print(f"FAIL {wd.name}: 缺少 audio.wav", flush=True)
        return
    result = mlx_whisper.transcribe(
        str(audio),
        path_or_hf_repo=MODEL,
        language="zh",
        initial_prompt=INITIAL_PROMPT,
    )
    segs = [
        {"index": i, "start": fmt_ts(s["start"]), "text": s["text"].strip()}
        for i, s in enumerate(result["segments"])
        if s["text"].strip()
    ]
    out_json.write_text(json.dumps(segs, ensure_ascii=False, indent=2), encoding="utf-8")
    full = "".join(s["text"] for s in segs)
    (wd / "transcript_full.txt").write_text(full, encoding="utf-8")
    print(f"DONE {wd.name}: {len(segs)} 段, {len(full)} 字", flush=True)


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        transcribe_one(Path(arg))
