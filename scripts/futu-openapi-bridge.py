#!/usr/bin/env python3
"""
futu-openapi-bridge — Futu OpenD (TCP protobuf) → HTTP JSON 桥，protocol-compatible
with @dshtrading/connector-futu 的假定契约（GET + query，响应 {retType, retMsg, data}）。

  OpenD(11111, TCP protobuf) ←futu-api SDK— bridge(127.0.0.1:11112, HTTP) ←— connector-futu

端点（connector-futu/src/rest.ts 实际消费面）：
  GET /api/qot/get-ticker?security=HK.00700
      → get_market_snapshot（不消耗订阅/历史额度）→ {curPrice,bidPrice,askPrice,volume,time}
  GET /api/qot/get-kl?security=HK.00700&klType=2&reqNum=200&rehabType=1
      → 自动订阅 K_*(消耗 1 个订阅槽，上限 100) + get_cur_kline（不消耗历史K线额度 6/100）
      → {klList:[{time,open,high,low,close,volume}]}，time 为 ISO UTC
  GET /api/qot/get-plate-security?plate=... → {securityList:[]}（listInstruments 静默空）
  其余（/api/trd/*）→ retType:-1（交易面保持关闭，liveTrading 恒 false）

时区：time_key/update_time 按市场本地墙钟解析（US=美东含夏令时，HK=北京），统一转 ISO UTC。

用法：
  python3 scripts/futu-openapi-bridge.py            # 前台
  nohup python3 scripts/futu-openapi-bridge.py &    # 后台（日志 scripts/futu-openapi-bridge.log）

依赖：pip install futu-api（本机已装 10.05.6508）；FutuOpenD 已启动并登录。
额度语义（2026-09-08 OpenD 控制台实证）：订阅 0/100，历史K线 6/100——本桥只用
订阅制 cur-kline + snapshot，不碰历史K线额度。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

from futu import OpenQuoteContext, KLType, SubType, AuType

LISTEN_HOST = '127.0.0.1'
# 默认 11112（LaunchAgent com.dshtrading.futu-openapi-bridge 托管 11112）；旁路验证/
# 并行实例用 FUTU_BRIDGE_PORT 覆盖，避免与常驻桥抢端口。
LISTEN_PORT = int(os.environ.get('FUTU_BRIDGE_PORT', '11112'))
OPEND_HOST = '127.0.0.1'
OPEND_PORT = 11111
HK_TZ = timezone(timedelta(hours=8))  # 港股墙钟（无夏令时）
# 美股 time_key 为美东墙钟（2026-09-08 OpenD 实证：US.AAPL 1m 尾巴 15:59/16:00=收盘分钟，
# 日线盖交易日 00:00；若按北京解析则分钟偏差 12h、日线日期错位一天）
_us_tz = None


def us_tz():
    """美东时区（含夏令时）。惰性解析：宿主无系统 tz 库（Windows 需 pip install tzdata）时
    只在请求美股时报错，港股面不受影响。"""
    global _us_tz
    if _us_tz is None:
        try:
            _us_tz = ZoneInfo('America/New_York')
        except Exception as exc:  # noqa: BLE001 —— 折成可执行报错，桥面统一 retType:-1
            raise RuntimeError(
                f"bridge: cannot load timezone 'America/New_York' ({exc}); "
                'install tzdata (pip install tzdata) for US quotes'
            ) from exc
    return _us_tz


def market_tz(security: str):
    """按证券前缀选墙钟时区：US.* 美东（含夏令时），其余（HK.*）北京时间。"""
    return us_tz() if security.upper().startswith('US.') else HK_TZ

KL_TYPE_TO_KLTYPE = {
    1: KLType.K_1M, 2: KLType.K_5M, 3: KLType.K_15M, 4: KLType.K_30M,
    5: KLType.K_60M, 6: KLType.K_DAY, 7: KLType.K_WEEK, 8: KLType.K_MON,
}
KL_TYPE_TO_SUBTYPE = {
    1: SubType.K_1M, 2: SubType.K_5M, 3: SubType.K_15M, 4: SubType.K_30M,
    5: SubType.K_60M, 6: SubType.K_DAY, 7: SubType.K_WEEK, 8: SubType.K_MON,
}

quote = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
subscribed: set[tuple[str, int]] = set()
lock = threading.Lock()  # futu-api ctx 非线程安全，串行化


def ok(data) -> dict:
    return {'retType': 0, 'retMsg': '', 'data': data}


def err(msg: str) -> dict:
    return {'retType': -1, 'retMsg': msg, 'data': None}


def wall_to_iso(value: str, tz) -> str:
    """'2026-09-08 11:35:00'（交易所本地墙钟，Futu 各市场按本地时间给 time_key/update_time）
    → ISO UTC（连接器 new Date(iso) 解析无歧义）。
    美股快照 update_time 可带毫秒小数（'…:12.412'），先剥掉再解析。"""
    text = value.strip()
    if '.' in text:
        text = text.split('.', 1)[0]
    if len(text) == 16:
        text += ':00'
    dt = datetime.strptime(text, '%Y-%m-%d %H:%M:%S').replace(tzinfo=tz)
    return dt.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def handle_get_ticker(q: dict) -> dict:
    code = (q.get('security') or [''])[0]
    ret, df = quote.get_market_snapshot([code])
    if ret != 0 or df.empty:
        return err(f'snapshot failed: {df}')
    row = df.iloc[0]
    update_time = str(row['update_time'])
    return ok({
        'curPrice': float(row['last_price']),
        'bidPrice': float(row['bid_price']) if row['bid_price'] > 0 else None,
        'askPrice': float(row['ask_price']) if row['ask_price'] > 0 else None,
        'volume': float(row['volume']),
        'time': wall_to_iso(update_time, market_tz(code)),
    })


def handle_get_kl(q: dict) -> dict:
    code = (q.get('security') or [''])[0]
    kl_type = int((q.get('klType') or ['2'])[0])
    req_num = max(1, min(int((q.get('reqNum') or ['100'])[0]), 1000))
    kltype = KL_TYPE_TO_KLTYPE.get(kl_type)
    subtype = KL_TYPE_TO_SUBTYPE.get(kl_type)
    if kltype is None:
        return err(f'unsupported klType {kl_type}')

    key = (code, kl_type)
    if key not in subscribed:
        ret, err_msg = quote.subscribe([code], [subtype], subscribe_push=False)
        if ret != 0:
            return err(f'subscribe {code} {subtype} failed: {err_msg}')
        subscribed.add(key)

    ret, df = quote.get_cur_kline(code, num=req_num, ktype=kltype, autype=AuType.QFQ)
    if ret != 0:
        return err(f'cur_kline failed: {df}')
    bars = []
    now = datetime.now(timezone.utc)
    tz = market_tz(code)
    for _, row in df.iterrows():
        iso = wall_to_iso(str(row['time_key']), tz)
        # 午休/收盘后 cur-kline 会预生成下一时段的占位 bar（量=0、时间为未来）——丢弃
        if datetime.fromisoformat(iso.replace('Z', '+00:00')) > now:
            continue
        bars.append({
            'time': iso,
            'open': float(row['open']),
            'high': float(row['high']),
            'low': float(row['low']),
            'close': float(row['close']),
            'volume': float(row['volume']),
        })
    return ok({'klList': bars})


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query)
        try:
            with lock:
                if parsed.path == '/api/qot/get-ticker':
                    body = handle_get_ticker(q)
                elif parsed.path == '/api/qot/get-kl':
                    body = handle_get_kl(q)
                elif parsed.path == '/api/qot/get-plate-security':
                    body = ok({'securityList': []})
                else:
                    body = err(f'bridge: unsupported path {parsed.path}')
        except Exception as exc:  # noqa: BLE001 —— 桥面把一切异常折成 retType:-1
            body = err(f'{type(exc).__name__}: {exc}')
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        print(f'{parsed.path}?{parsed.query} -> retType={body.get("retType")}', flush=True)

    def log_message(self, *args) -> None:  # 静默默认访问日志（保留上方业务日志）
        return


if __name__ == '__main__':
    print(f'futu-openapi-bridge listening on {LISTEN_HOST}:{LISTEN_PORT} -> OpenD {OPEND_HOST}:{OPEND_PORT}', flush=True)
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
