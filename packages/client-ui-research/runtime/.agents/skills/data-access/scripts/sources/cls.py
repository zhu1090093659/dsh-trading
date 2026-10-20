"""财联社源:电报(全市场实时快讯),v1 API + 本地签名,零 key。移植自 a-stock-data SKILL.md §5.2。"""
from __future__ import annotations

import hashlib
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import TZ_SH, UA  # noqa: E402
from sources._http import http_json  # noqa: E402


def cls_telegraph(page_size: int = 50) -> list[dict]:
    """[{title, content, time(YYYY-MM-DD HH:MM:SS 北京时间)}]"""
    params = {"appName": "CailianpressWeb", "os": "web", "sv": "7.7.5", "last_time": "", "refresh_type": "1", "rn": str(page_size)}
    qs = "&".join(f"{k}={params[k]}" for k in sorted(params))
    sign = hashlib.md5(hashlib.sha1(qs.encode()).hexdigest().encode()).hexdigest()
    d = http_json(f"https://www.cls.cn/v1/roll/get_roll_list?{qs}&sign={sign}", headers={"User-Agent": UA, "Referer": "https://www.cls.cn/"}, timeout=10)
    rows = []
    for item in (d.get("data") or {}).get("roll_data") or []:
        ts = item.get("ctime")
        rows.append({"title": item.get("title", "") or item.get("brief", ""), "content": item.get("content", "") or item.get("brief", ""),
                     "time": datetime.fromtimestamp(ts, TZ_SH).strftime("%Y-%m-%d %H:%M:%S") if ts else ""})
    return rows
