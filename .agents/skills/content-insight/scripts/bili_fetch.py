#!/usr/bin/env python3
"""
bili_fetch.py — B站视频素材获取（一键完成：元数据 + 字幕尝试 + 音频下载 + 分段）

用法:
  python bili_fetch.py <B站链接或BV号> <工作目录> [--page N]

输入支持:
  - 完整链接: https://www.bilibili.com/video/BV1Za4C6WEUw/?p=2
  - 短链:     https://b23.tv/xxxxxx（自动跟随跳转解析）
  - 裸BV号:   BV1Za4C6WEUw

自动执行:
  1. 解析 BV 号与分P参数
  2. 访问B站主页获取 cookie（防412反爬）
  3. view API 获取元数据（标题/UP主/时长/cid/分P列表）
  4. 尝试官方字幕接口（player/wbi/v2, WBI签名+cookie）
  5. 无字幕时: playurl(fnval=16 DASH) 获取音频流 → 下载 → ffmpeg 转
     16kHz单声道WAV → 按29秒分段（适配ASR 30秒限制）

结束行输出机器可读状态（供上层 Agent 编排判断）:
  RESULT: {"status": "SUBTITLES_FOUND" | "AUDIO_CHUNKED" | "FAILED", ...}
"""
import json, os, re, sys, time, hashlib, subprocess, urllib.request, urllib.parse, http.cookiejar

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
CHUNK_SEC = 29  # ASR单次限制30秒，留1秒余量


def fail(msg, **extra):
    print(f'错误: {msg}')
    print('RESULT: ' + json.dumps({'status': 'FAILED', 'error': msg, **extra}, ensure_ascii=False))
    sys.exit(1)


def parse_input(text):
    """从用户输入提取 (bvid, page)。"""
    text = text.strip()
    page = None
    m = re.search(r'[?&]p=(\d+)', text)
    if m:
        page = int(m.group(1))
    m = re.search(r'(BV[0-9A-Za-z]{10})', text)
    if m:
        return m.group(1), page
    # b23.tv 短链 → 跟随跳转
    if 'b23.tv' in text:
        url = text if text.startswith('http') else 'https://' + text
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        try:
            final = urllib.request.urlopen(req, timeout=30).geturl()
            m = re.search(r'(BV[0-9A-Za-z]{10})', final)
            if m:
                p = re.search(r'[?&]p=(\d+)', final)
                return m.group(1), (page or (int(p.group(1)) if p else None))
        except Exception as e:
            fail(f'短链解析失败: {e}')
    fail(f'无法从输入中解析BV号: {text[:80]}')


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    bvid, page = parse_input(args[0])
    workdir = os.path.abspath(args[1])
    if '--page' in args:
        page = int(args[args.index('--page') + 1])
    os.makedirs(workdir, exist_ok=True)

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.addheaders = [
        ('User-Agent', UA),
        ('Referer', f'https://www.bilibili.com/video/{bvid}/'),
        ('Origin', 'https://www.bilibili.com'),
    ]

    def get(url):
        resp = opener.open(url, timeout=30)
        return json.load(resp)

    # --- 1. 主页取cookie（防412） ---
    try:
        opener.open(urllib.request.Request('https://www.bilibili.com/', headers={'User-Agent': UA}), timeout=30).read(1024)
    except Exception as e:
        print(f'警告: 主页cookie获取失败({e})，继续尝试')

    # --- 2. 元数据 ---
    info = get(f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}')
    if info.get('code') != 0:
        fail(f'视频信息获取失败 code={info.get("code")}: {info.get("message")}（-404=视频不存在）')
    d = info['data']
    pages = d.get('pages') or [{'cid': d['cid'], 'page': 1, 'part': d['title']}]
    page = page or 1
    if page > len(pages):
        fail(f'分P越界: 请求第{page}P但共{len(pages)}P', total_pages=len(pages))
    cid = pages[page - 1]['cid']
    video_info = {
        'bvid': bvid, 'cid': str(cid), 'page': page, 'total_pages': len(pages),
        'title': d['title'], 'uploader': d['owner']['name'],
        'duration_sec': pages[page - 1].get('duration', d.get('duration', 0)),
        'desc': (d.get('desc') or '')[:300],
        'link': f'https://www.bilibili.com/video/{bvid}/' + (f'?p={page}' if len(pages) > 1 else ''),
    }
    with open(os.path.join(workdir, 'video_info.json'), 'w', encoding='utf-8') as f:
        json.dump(video_info, f, ensure_ascii=False, indent=2)
    print(f"视频: {video_info['title']} | UP主: {video_info['uploader']} | "
          f"时长: {video_info['duration_sec']//60}分{video_info['duration_sec']%60}秒 | "
          f"P{page}/{len(pages)}")
    if len(pages) > 1 and page == 1:
        print(f'注意: 该视频有{len(pages)}个分P，默认处理第1P；如需其他分P请用 --page N 重新运行')

    # --- 3. WBI签名工具 ---
    nav = get('https://api.bilibili.com/x/web-interface/nav')
    wbi_img = nav['data']['wbi_img']
    img_key = wbi_img['img_url'].split('/')[-1].split('.')[0]
    sub_key = wbi_img['sub_url'].split('/')[-1].split('.')[0]

    def getMixinKey(orig):
        return ''.join(orig[i] for i in [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52])[:32]

    def wbi_sign(params):
        mixin_key = getMixinKey(img_key + sub_key)
        params = dict(params)
        params['wts'] = int(time.time())
        params = {k: str(v) for k, v in sorted(params.items())}
        query = urllib.parse.urlencode(params)
        params['w_rid'] = hashlib.md5((query + mixin_key).encode()).hexdigest()
        return params

    # --- 4. 尝试官方字幕（有则免ASR，最优先路径） ---
    try:
        pdata = get('https://api.bilibili.com/x/player/wbi/v2?' +
                    urllib.parse.urlencode(wbi_sign({'bvid': bvid, 'cid': cid, 'aid': '0'})))
        subs = pdata.get('data', {}).get('subtitle', {}).get('subtitles', [])
        if subs:
            # 优先中文，其次第一个
            sub = next((s for s in subs if str(s.get('lan', '')).startswith('zh')), subs[0])
            sub_url = sub.get('subtitle_url', '')
            if sub_url.startswith('//'):
                sub_url = 'https:' + sub_url
            req = urllib.request.Request(sub_url, headers={'User-Agent': UA, 'Referer': 'https://www.bilibili.com/'})
            sub_json = json.load(urllib.request.urlopen(req, timeout=30))
            body = sub_json.get('body', [])
            segments = [{'index': i,
                         'start': fmt_ts(int(s['from'])),
                         'text': s['content'].strip()} for i, s in enumerate(body) if s.get('content', '').strip()]
            if segments:
                with open(os.path.join(workdir, 'subtitles.json'), 'w', encoding='utf-8') as f:
                    json.dump(segments, f, ensure_ascii=False, indent=2)
                print(f'官方字幕获取成功: {len(segments)}条（语言 {sub.get("lan")}），无需ASR转写')
                print('RESULT: ' + json.dumps({'status': 'SUBTITLES_FOUND', 'segments': len(segments),
                                               'workdir': workdir, **video_info}, ensure_ascii=False))
                return
        print('官方字幕不可用（未登录态下AI字幕通常为空）→ 走音频转写路径')
    except Exception as e:
        print(f'字幕接口异常({e}) → 走音频转写路径')

    # --- 5. 音频流地址 ---
    pdata = get('https://api.bilibili.com/x/player/wbi/playurl?' + urllib.parse.urlencode(
        wbi_sign({'bvid': bvid, 'cid': cid, 'qn': '0', 'fnval': '16', 'fnver': '0', 'fourk': '1', 'platform': 'pc'})))
    if pdata.get('code') != 0:
        fail(f'播放地址获取失败 code={pdata.get("code")}: {pdata.get("message")}（-404=需登录/VIP视频）')
    pd = pdata.get('data', {})
    audio_url = None
    audios = (pd.get('dash') or {}).get('audio') or []
    if audios:
        best = max(audios, key=lambda a: a.get('bandwidth', 0))
        audio_url = best['baseUrl']
        print(f"音频流: id={best.get('id')}, 码率={best.get('bandwidth')}, 大小≈{best.get('size', 0)/1024/1024:.1f}MB")
    elif pd.get('durl'):
        audio_url = pd['durl'][0]['url']  # 老视频无DASH时的合并流回退
        print('使用durl合并流（老视频格式）')
    else:
        fail('playurl返回中既无dash.audio也无durl，无法下载音频')

    # --- 6. 下载音频（流地址有时效，立即下载） ---
    raw_path = os.path.join(workdir, 'audio_raw.m4s')
    req = urllib.request.Request(audio_url, headers={'User-Agent': UA, 'Referer': f'https://www.bilibili.com/video/{bvid}/', 'Range': 'bytes=0-'})
    try:
        data = urllib.request.urlopen(req, timeout=300).read()
    except Exception as e:
        fail(f'音频下载失败: {e}（流地址可能已过期，请重新运行本脚本）')
    with open(raw_path, 'wb') as f:
        f.write(data)
    print(f'音频下载完成: {len(data)/1024/1024:.2f} MB')

    # --- 7. ffmpeg 转码 + 29秒分段 ---
    if subprocess.call(['which', 'ffmpeg'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
        fail('ffmpeg不可用，请先安装: apt install ffmpeg 或 brew install ffmpeg')
    wav_path = os.path.join(workdir, 'audio.wav')
    chunks_dir = os.path.join(workdir, 'chunks')
    os.makedirs(chunks_dir, exist_ok=True)
    r1 = subprocess.run(['ffmpeg', '-y', '-i', raw_path, '-vn', '-acodec', 'pcm_s16le',
                         '-ar', '16000', '-ac', '1', wav_path],
                        capture_output=True, text=True)
    if r1.returncode != 0 or not os.path.exists(wav_path):
        fail('ffmpeg转码WAV失败', stderr=r1.stderr[-300:])
    r2 = subprocess.run(['ffmpeg', '-y', '-i', wav_path, '-f', 'segment', '-segment_time', str(CHUNK_SEC),
                         '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
                         os.path.join(chunks_dir, 'chunk_%03d.wav')],
                        capture_output=True, text=True)
    if r2.returncode != 0:
        fail('ffmpeg分段失败', stderr=r2.stderr[-300:])
    # 清理中间文件，保留WAV备查
    os.remove(raw_path)
    chunks = sorted(f for f in os.listdir(chunks_dir) if f.endswith('.wav'))
    if not chunks:
        fail('分段后未产生任何音频块，请检查音频是否有效')
    est_min = len(chunks) * CHUNK_SEC // 60
    print(f'分段完成: {len(chunks)}个音频块 → {chunks_dir}')
    print(f'预计ASR转写耗时: 约{est_min}~{est_min + len(chunks) * CHUNK_SEC // 240 + 1}分钟（含限流退避）')
    print('RESULT: ' + json.dumps({'status': 'AUDIO_CHUNKED', 'chunks': len(chunks),
                                   'workdir': workdir, **video_info}, ensure_ascii=False))


def fmt_ts(sec):
    """秒 → HH:MM:SS"""
    sec = int(sec)
    return f'{sec//3600:02d}:{sec%3600//60:02d}:{sec%60:02d}'


if __name__ == '__main__':
    main()
