#!/usr/bin/env python3
"""
wechat_fetch.py — 微信公众号文章抓取与正文提取

用法:
  python wechat_fetch.py <微信文章链接> <工作目录>

支持链接形式:
  https://mp.weixin.qq.com/s/xxxxxxxx
  https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...&sn=...

自动执行:
  1. 完整桌面浏览器头直接抓取（反爬关键：头部指纹必须完整，实测可过；
     手机UA反而会跳转验证码，不要用）
  2. 被拦截时自动重试：第二次预热cookie重抓，第三次冷却90秒后重抓
     （微信风控是频率性的，短时多次请求会触发临时限流，冷却即可解除）
  3. 解析元数据（标题/公众号/作者/发布时间/原文链接）
  4. 提取 js_content 正文 → 纯文本（保留段落结构，图片替换为[图片N]占位）

产物:
  <工作目录>/article.html       原始HTML（备查）
  <工作目录>/article.json       结构化元数据+正文
  <工作目录>/article_text.txt   纯文本正文（分析底稿）

结束行输出: RESULT: {"status": "ARTICLE_FETCHED" | "FAILED", ...}
"""
import json, os, re, sys, html as htmllib, urllib.request, http.cookiejar
from datetime import datetime, timezone, timedelta

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36')
# 反爬关键：头部指纹必须完整（Accept/Accept-Language/Upgrade-Insecure-Requests 缺一可能被拦）
HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
}
TZ = timezone(timedelta(hours=8))  # 微信时间戳为东八区

BLOCK_MARKS = ('环境异常', 'wappoc_appmsgcaptcha', '完成验证后即可继续访问')
GONE_MARKS = ('该内容已被发布者删除', '此内容因违规无法查看', '该内容暂时无法查看',
              '此内容发送失败', '被投诉侵权')


def fail(msg, **extra):
    print(f'错误: {msg}')
    print('RESULT: ' + json.dumps({'status': 'FAILED', 'error': msg, **extra}, ensure_ascii=False))
    sys.exit(1)


def fetch(url, opener=None, timeout=60):
    req = urllib.request.Request(url, headers=HEADERS)
    opener_fn = opener.open if opener else urllib.request.urlopen
    resp = opener_fn(req, timeout=timeout)
    raw = resp.read()
    if resp.headers.get('Content-Encoding') == 'gzip':
        import gzip
        raw = gzip.decompress(raw)
    return raw.decode('utf-8', 'ignore')


def extract_js_content(html):
    """定位 js_content 起始，用 div 配平找到匹配的闭合标签。"""
    m = re.search(r'<div[^>]*id="js_content"[^>]*>', html)
    if not m:
        return None
    start = m.end()
    depth, pos = 1, start
    tag_re = re.compile(r'<(/?)div\b[^>]*>', re.I)
    for t in tag_re.finditer(html, start):
        depth += -1 if t.group(1) else 1
        if depth == 0:
            pos = t.start()
            break
    return html[start:pos] if depth == 0 else None


def html_to_text(inner):
    """微信富文本 → 纯文本。图片换[图片N]占位，块级标签换行，保留段落结构。"""
    text_img = re.compile(r'<img[^>]*>', re.I)
    images = []

    def img_sub(m):
        tag = m.group(0)
        src = re.search(r'data-src="([^"]+)"', tag)
        images.append(src.group(1) if src else '')
        return f'\n[图片{len(images)}]\n'

    s = re.sub(r'<script[^>]*>[\s\S]*?</script>', '', inner, flags=re.I)
    s = re.sub(r'<style[^>]*>[\s\S]*?</style>', '', s, flags=re.I)
    s = re.sub(r'<!--[\s\S]*?-->', '', s)
    s = text_img.sub(img_sub, s)
    # 块级标签边界 → 换行
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    s = re.sub(r'</(p|section|h[1-6]|li|tr|blockquote|pre|div)>', '\n', s, flags=re.I)
    # 去掉剩余所有标签
    s = re.sub(r'<[^>]+>', '', s)
    s = htmllib.unescape(s)
    # 逐行清理：去首尾空白、压缩行内空白、去空行
    lines = []
    for ln in s.split('\n'):
        ln = re.sub(r'\s+', ' ', ln).strip()
        if ln:
            lines.append(ln)
    return '\n\n'.join(lines), images


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    url, workdir = args[0].strip(), os.path.abspath(args[1])
    if 'mp.weixin.qq.com' not in url:
        fail(f'不是微信文章链接: {url[:80]}')
    os.makedirs(workdir, exist_ok=True)

    # --- 抓取（三次尝试：直接抓 / cookie预热 / 冷却90秒） ---
    html = None
    import time
    attempts = [(1, '直接抓取', 0), (2, 'cookie预热后重试', 0), (3, '冷却90秒后重试', 90)]
    for attempt, label, cool in attempts:
        if cool:
            print(f'等待{cool}秒让风控解除...')
            time.sleep(cool)
        try:
            if attempt == 2:
                cj = http.cookiejar.CookieJar()
                op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
                try:
                    op.open(urllib.request.Request('https://mp.weixin.qq.com/', headers=HEADERS), timeout=30).read(1024)
                except Exception:
                    pass
                html = fetch(url, opener=op)
            else:
                html = fetch(url)
            blocked = any(k in html for k in BLOCK_MARKS) and 'js_content' not in html
            gone = any(k in html for k in GONE_MARKS)
            if gone:
                fail('文章已删除/违规/不可见，无法获取', url=url)
            if not blocked and 'js_content' in html:
                break
            print(f'{label}被反爬拦截（环境异常验证页），重试...')
        except Exception as e:
            print(f'{label}失败: {e}')
            html = None
    if not html or 'js_content' not in html:
        fail('微信反爬拦截且三次重试无效。建议：① 等待5-10分钟后再运行一次（IP风控冷却）；'
             '② 请用户在微信中打开文章，复制正文粘贴到对话；③ 尝试 agent-browser 无头浏览器方案',
             url=url)

    # --- 元数据 ---
    def rx(pat, flags=re.S):
        m = re.search(pat, html, flags)
        return m.group(1).strip() if m else ''

    title = rx(r'<h1[^>]*id="activity-name"[^>]*>(.*?)</h1>')
    title = re.sub(r'<[^>]+>', '', title).strip() or rx(r'<meta[^>]*property="og:title"[^>]*content="([^"]*)"')
    account = re.sub(r'<[^>]+>', '', rx(r'<(?:span|a)[^>]*id="js_name"[^>]*>(.*?)</(?:span|a)>')).strip()
    author = rx(r'<meta[^>]*name="author"[^>]*content="([^"]*)"')
    ts = rx(r'var\s+ct\s*=\s*"?(\d{10})') or rx(r'cts\s*=\s*"?(\d{10})')
    publish_time = ''
    if ts:
        publish_time = datetime.fromtimestamp(int(ts), TZ).strftime('%Y-%m-%d %H:%M')
    else:
        publish_time = re.sub(r'<[^>]+>', '', rx(r'<em[^>]*id="publish_time"[^>]*>(.*?)</em>')).strip()
    canonical = rx(r'var\s+msg_link\s*=\s*[\'"]([^\'"]+)[\'"]').replace('&amp;', '&') or url

    # --- 正文 ---
    inner = extract_js_content(html)
    if not inner:
        fail('js_content定位失败（页面结构可能变化），请反馈样本')
    text, images = html_to_text(inner)
    if len(text) < 50:
        fail(f'正文提取过短({len(text)}字)，可能是图片型文章或结构变化', images=len(images))

    # --- 落盘 ---
    with open(os.path.join(workdir, 'article.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    article = {
        'url': url, 'canonical_url': canonical, 'title': title,
        'account': account, 'author': author, 'publish_time': publish_time,
        'chars': len(text), 'images': [i for i in images if i], 'text': text,
    }
    with open(os.path.join(workdir, 'article.json'), 'w', encoding='utf-8') as f:
        json.dump(article, f, ensure_ascii=False, indent=2)
    with open(os.path.join(workdir, 'article_text.txt'), 'w', encoding='utf-8') as f:
        f.write(f'《{title}》\n公众号：{account}' +
                (f'（作者：{author}）' if author and author != account else '') + '\n' +
                (f'发布时间：{publish_time}\n' if publish_time else '') +
                f'链接：{canonical}\n' + '=' * 60 + '\n\n' + text + '\n')

    print(f'标题: {title}')
    print(f'公众号: {account}' + (f' | 作者: {author}' if author and author != account else ''))
    print(f'发布时间: {publish_time or "未知"} | 正文: {len(text)}字 | 图片: {len(images)}张')
    print('RESULT: ' + json.dumps({
        'status': 'ARTICLE_FETCHED', 'workdir': workdir, 'title': title,
        'account': account, 'publish_time': publish_time, 'chars': len(text),
        'images': len(images)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
