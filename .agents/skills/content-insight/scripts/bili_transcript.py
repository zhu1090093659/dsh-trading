#!/usr/bin/env python3
"""
bili_transcript.py — 将转写/字幕结果整理为可交付的字幕文稿

用法:
  python bili_transcript.py <工作目录> --output <输出文件路径> [--source auto]

自动读取（优先级）:
  1. <工作目录>/transcript_full.json （ASR转写结果）
  2. <工作目录>/subtitles.json       （官方字幕）
  3. <工作目录>/video_info.json      （自动填充标题/UP主/链接）

输出文稿包含两个版本:
  A. 带时间戳版（每29秒/每条字幕一个时间戳，便于回查定位）
  B. 纯文本版（按语义断句分段，便于阅读与二次加工）
"""
import json, os, re, argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('workdir')
    ap.add_argument('--output', required=True, help='输出文稿路径（建议放download/，用描述性中文文件名）')
    ap.add_argument('--source', default='auto', choices=['auto', 'asr', 'subtitle'])
    args = ap.parse_args()
    wd = args.workdir

    # 读取 segments
    segments, source = None, args.source
    for name, src in [('transcript_full.json', 'asr'), ('subtitles.json', 'subtitle')]:
        p = os.path.join(wd, name)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                segments = json.load(f)
            if args.source == 'auto' or args.source == src:
                source = src
            break
    if not segments:
        raise SystemExit(f'错误: {wd} 下既无 transcript_full.json 也无 subtitles.json，请先完成转写')

    # 读取视频信息
    info = {}
    info_path = os.path.join(wd, 'video_info.json')
    if os.path.exists(info_path):
        with open(info_path, encoding='utf-8') as f:
            info = json.load(f)
    title = info.get('title', '未命名视频')
    uploader = info.get('uploader', '未知UP主')
    link = info.get('link', '')
    dur = info.get('duration_sec', 0)

    def fmt_short(ts):
        # HH:MM:SS → 超过1小时保留时位，否则显示 MM:SS
        parts = ts.split(':')
        return ts if parts[0] != '00' else f'{parts[1]}:{parts[2]}'

    lines = []
    lines.append(f'《{title}》视频字幕文稿')
    lines.append('=' * 60)
    lines.append(f'UP主：{uploader}')
    if link:
        lines.append(f'视频链接：{link}')
    if dur:
        lines.append(f'视频时长：{dur // 60}分{dur % 60}秒')
    if source == 'asr':
        lines.append('说明：本稿由视频音频经语音识别转写生成，可能存在少量同音字误差')
    else:
        lines.append('说明：本稿来自B站官方字幕轨')
    lines.append('=' * 60)
    lines.append('')

    for seg in segments:
        text = seg.get('text', '').strip()
        if text:
            lines.append(f"[{fmt_short(seg.get('start', '00:00:00'))}] {text}")
            lines.append('')

    lines.append('=' * 60)
    lines.append('【纯文本版（无时间戳）】')
    lines.append('=' * 60)
    lines.append('')
    full = ''.join(seg.get('text', '').strip() for seg in segments if seg.get('text', '').strip())
    # 按句号/问号/叹号断句，每段约180字
    sentences = re.split(r'(?<=[。！？])', full)
    para, paras = '', []
    for s in sentences:
        para += s
        if len(para) > 180:
            paras.append(para)
            para = ''
    if para:
        paras.append(para)
    for p in paras:
        lines.append(p)
        lines.append('')

    out = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f'文稿已保存: {out}')
    print(f'总字数: {len(full)} | 来源: {"ASR转写" if source == "asr" else "官方字幕"} | 分段数: {len(segments)}')


if __name__ == '__main__':
    main()
