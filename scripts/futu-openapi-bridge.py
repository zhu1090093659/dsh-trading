#!/usr/bin/env python3
"""
futu-openapi-bridge — Futu OpenD (TCP protobuf) → HTTP JSON 桥，protocol-compatible
with @dshtrading/connector-futu 的假定契约（GET + query，响应 {retType, retMsg, data}）。

  OpenD(11111, TCP protobuf) ←futu-api SDK— bridge(127.0.0.1:11112, HTTP) ←— connector-futu

端点（connector-futu/src/rest.ts 实际消费面）：
  GET /api/qot/get-ticker?security=HK.00700
      → get_market_snapshot（不消耗订阅/历史额度）→ {curPrice,bidPrice,askPrice,volume,time}
  GET /api/qot/get-kl?security=HK.00700&klType=2&reqNum=200&rehabType=1
      → 自动订阅 K_*(消耗 1 个订阅槽；上限 100，FUTU_BRIDGE_MAX_SUBSCRIPTIONS 可覆盖，
        满额按 LRU 自动 unsubscribe 淘汰) + get_cur_kline（不消耗历史K线额度 6/100）
      → {klList:[{time,open,high,low,close,volume}]}，time 为 ISO UTC
  GET /api/qot/get-plate-security?plate=... → {securityList:[]}（listInstruments 静默空）

交易面（**POST + JSON body**；owner 2026-10-08 裁决传输只有一种、主仓客户端也改成 POST。
形态与行情面同一套信封 {retType, retMsg, data}，retType===0 才算成功）：
  POST /api/trd/place-order  {security, trdSide(1买2卖), orderType(1限价2市价), qty,
                              price(市价给 0), trdEnv('SIMULATE'|'REAL'), accId?, remark?}
      → {orderId}（OpenD 回的真 id；它没给就报错，绝不自己编）
  POST /api/trd/get-orders   {market('HK'|'US'), trdEnv, accId?}
      → {orders:[{orderId, code, orderStatus, remark, ...}]}
        （前四个是执行核对账要的；orderStatus 是 OpenD 的状态串原文，映射归消费方的 stateOf）
  POST /api/trd/cancel-order {orderId, trdEnv, accId}（accId 必填：请求里没有 market，不猜上下文）
  GET 落到这三条 → retType:-1（trd paths are POST-only）；其它路径 → retType:-1（unsupported path）
  trdEnv 必填（没有"默认实盘"，也不替你挑环境）；accId 缺省/0 = OpenD 默认账户；
  **一个市场的账户不能拿去交易另一个市场**（accId 与 security/market 不符即拒）。
  unlock_trade 不在桥里做：账户密码是**人本**前置，不进仓库、不进本脚本。

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
import re
import threading
from collections import OrderedDict
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

from futu import (
    AuType,
    KLType,
    ModifyOrderOp,
    OpenQuoteContext,
    OpenSecTradeContext,
    OrderType,
    SecurityFirm,
    SubType,
    TrdEnv,
    TrdMarket,
    TrdSide,
)

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
# 订阅槽 LRU（2026-09-08 审查 M2）：OpenD 每连接订阅上限 100，此前只增不减——
# 累计 100 个 (security, klType) 后所有新订阅失败、分钟线全错，直到重启桥。
# 命中上限时按最久未用淘汰并 unsubscribe，槽位可回收。
MAX_SUBSCRIPTIONS = max(1, int(os.environ.get('FUTU_BRIDGE_MAX_SUBSCRIPTIONS', '100')))
subscribed: "OrderedDict[tuple[str, int], None]" = OrderedDict()
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
        while len(subscribed) >= MAX_SUBSCRIPTIONS:
            old_code, old_type = subscribed.popitem(last=False)
            old_subtype = KL_TYPE_TO_SUBTYPE.get(old_type)
            if old_subtype is None:
                continue
            try:
                quote.unsubscribe([old_code], [old_subtype])
                print(f'unsubscribed {old_code} {old_subtype} (LRU eviction)', flush=True)
            except Exception as exc:  # noqa: BLE001 —— 淘汰失败不阻塞新订阅
                print(f'unsubscribe {old_code} {old_subtype} failed: {exc}', flush=True)
        ret, err_msg = quote.subscribe([code], [subtype], subscribe_push=False)
        if ret != 0:
            return err(f'subscribe {code} {subtype} failed: {err_msg}')
        subscribed[key] = None
        print(f'subscribed {code} {subtype} ({len(subscribed)}/{MAX_SUBSCRIPTIONS})', flush=True)
    else:
        subscribed.move_to_end(key)

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


# ---------------------------------------------------------------------------
# 交易面（POST + JSON）。三条路由的请求/响应形态由执行核的适配器钉死：
# dsh-trading-bot packages/tradectl/src/adapters/futu-bridge.ts（本桥是它的部署侧实现）。
# 纪律：trdEnv 必填（没有默认实盘）、accId 缺省 0 = OpenD 默认账户、市场与账户不许互相顶替、
# 认不出的输入一律 retType:-1（不猜、不编 id）。
# ---------------------------------------------------------------------------

TRD_PATHS = ('/api/trd/place-order', '/api/trd/get-orders', '/api/trd/cancel-order')
POST_ONLY_MESSAGE = 'bridge: trd paths are POST-only (JSON body)'
TRD_MARKET_ENUM = {'HK': TrdMarket.HK, 'US': TrdMarket.US}
# "还挂在 venue 上"的状态：部分成交仍有未成交余量，撤单中的单子也还没落地——
# 一律按**仍在**取回（把可能还活着的挂单读成"没有"是对账层面的 fail-open）。
OPEN_ORDER_STATUSES = [
    'SUBMITTED', 'SUBMITTING', 'WAITING_SUBMIT', 'UNSUBMITTED',
    'FILLED_PART', 'CANCELLING_ALL', 'CANCELLING_PART',
]

_trade_contexts: "dict[str, OpenSecTradeContext]" = {}
_acc_markets: "dict[int, str] | None" = None


def trade_ctx(market: str) -> OpenSecTradeContext:
    """按市场建（并复用）交易上下文：HK / US 是两套 trd 上下文，账户不通用。"""
    ctx = _trade_contexts.get(market)
    if ctx is None:
        ctx = OpenSecTradeContext(
            filter_trdmarket=TRD_MARKET_ENUM[market], host=OPEND_HOST, port=OPEND_PORT,
            security_firm=SecurityFirm.FUTUSECURITIES,
        )
        _trade_contexts[market] = ctx
    return ctx


def acc_markets() -> dict:
    """accId → 市场（OpenD 的账户表）。全量取回或整体抛错，不返回半份。"""
    global _acc_markets
    if _acc_markets is None:
        table: "dict[int, str]" = {}
        for market in TRD_MARKET_ENUM:
            ret, df = trade_ctx(market).get_acc_list()
            if ret != 0:
                raise RuntimeError(f'get_acc_list({market}) failed: {df}')
            for _, row in df.iterrows():
                table[int(row['acc_id'])] = market
        _acc_markets = table
    return _acc_markets


def cell(row, name: str, default=''):
    """DataFrame 一格 → 值；列缺失/NaN 一律折成 default（不把 NaN 写进 JSON）。"""
    try:
        value = row[name]
    except Exception:  # noqa: BLE001 —— 缺列由调用方判，不是崩溃理由
        return default
    if value is None:
        return default
    try:
        if value != value:  # NaN 自我不等
            return default
    except Exception:  # noqa: BLE001
        pass
    return value


def text_of(value) -> str:
    return '' if value is None else str(value)


def number_of(value) -> float:
    try:
        return float(value)
    except Exception:  # noqa: BLE001
        return 0.0


def trd_env_of(env):
    """请求里的环境字面量 → SDK 枚举；认不出一律 None（由调用方拒绝）。"""
    if env == 'SIMULATE':
        return TrdEnv.SIMULATE
    if env == 'REAL':
        return TrdEnv.REAL
    return None


def acc_id_of(body: dict):
    """→ (accId, 错误消息)。缺省/0 = OpenD 默认账户（SDK 语义）。

    接受整数**或十进制数字字符串**：部署侧的账户 id 从 CLI/环境变量一路传下来是字符串
    （执行核适配器的 `accounts` 就是 string），这里按值解析、不按 JSON 类型挑剔；
    非数字、负数、布尔一律拒（不猜账户）。
    """
    raw = body.get('accId', 0)
    if raw is None or raw == '':
        return 0, None
    if isinstance(raw, bool):
        return 0, f'bridge: accId 不能是布尔值，收到 {raw!r}'
    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, str) and re.fullmatch(r'[0-9]+', raw.strip()):
        value = int(raw.strip())
    elif isinstance(raw, float) and raw.is_integer():
        value = int(raw)
    else:
        return 0, f'bridge: accId 必须是整数或十进制数字字符串，收到 {raw!r}'
    if value < 0:
        return 0, f'bridge: accId 不能为负，收到 {raw!r}'
    return value, None


def acc_market_problem(acc_id: int, market: str):
    """accId（非 0 时）必须属于这个市场——不拿一个市场的账户顶替另一个市场。"""
    if acc_id == 0:
        return None
    found = acc_markets().get(acc_id, '')
    if found == '':
        return f'bridge: accId {acc_id} 不在 OpenD 的账户表里（不猜账户）'
    if found != market:
        return f'bridge: accId {acc_id} 属于 {found}，不能拿去交易 {market}'
    return None


def handle_place_order(body: dict) -> dict:
    security = body.get('security')
    if not isinstance(security, str) or security.strip() == '':
        return err("place-order: security 必填（HK.00700 / US.AAPL）")
    security = security.strip().upper()
    market = 'HK' if security.startswith('HK.') else 'US' if security.startswith('US.') else ''
    if market == '':
        return err(f'place-order: 认不出的 security {security!r}（只服务 HK.* / US.*）')
    trd_side = body.get('trdSide')
    if trd_side not in (1, 2):
        return err(f'place-order: trdSide 必须是 1(买)/2(卖)，收到 {trd_side!r}')
    order_type = body.get('orderType')
    if order_type not in (1, 2):
        return err(f'place-order: orderType 必须是 1(限价)/2(市价)，收到 {order_type!r}')
    qty = body.get('qty')
    if isinstance(qty, bool) or not isinstance(qty, (int, float)) or qty <= 0:
        return err(f'place-order: qty 必须是正数，收到 {qty!r}')
    price = body.get('price', 0)
    if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0:
        return err(f'place-order: price 必须是非负数，收到 {price!r}')
    if order_type == 1 and price <= 0:
        return err('place-order: 限价单（orderType=1）必须带正数 price')
    env = trd_env_of(body.get('trdEnv'))
    if env is None:
        return err(f"place-order: trdEnv 必须是 'SIMULATE' 或 'REAL'（不默认实盘），收到 {body.get('trdEnv')!r}")
    acc_id, problem = acc_id_of(body)
    if problem is not None:
        return err(problem)
    problem = acc_market_problem(acc_id, market)
    if problem is not None:
        return err(problem)
    remark = body.get('remark')
    if remark is not None and not isinstance(remark, str):
        return err('place-order: remark 必须是字符串（它是执行核的对账锚）')

    ret, df = trade_ctx(market).place_order(
        price=float(price), qty=float(qty), code=security,
        trd_side=TrdSide.BUY if trd_side == 1 else TrdSide.SELL,
        order_type=OrderType.NORMAL if order_type == 1 else OrderType.MARKET,
        trd_env=env, acc_id=acc_id, remark=remark,
    )
    if ret != 0:
        return err(f'place-order rejected by OpenD: {df}')
    order_id = text_of(cell(df.iloc[0], 'order_id')) if len(df) > 0 else ''
    if order_id.strip() == '':
        return err('place-order: OpenD 回了成功但没给 order_id —— 拿不到 venue 侧句柄就不算已提交（不编 id）')
    return ok({'orderId': order_id, 'code': security})


def handle_get_orders(body: dict) -> dict:
    market = body.get('market')
    if not isinstance(market, str) or market.strip().upper() not in TRD_MARKET_ENUM:
        return err(f"get-orders: market 必须是 'HK' 或 'US'，收到 {market!r}")
    market = market.strip().upper()
    env = trd_env_of(body.get('trdEnv'))
    if env is None:
        return err(f"get-orders: trdEnv 必须是 'SIMULATE' 或 'REAL'，收到 {body.get('trdEnv')!r}")
    acc_id, problem = acc_id_of(body)
    if problem is not None:
        return err(problem)
    problem = acc_market_problem(acc_id, market)
    if problem is not None:
        return err(problem)

    ret, df = trade_ctx(market).order_list_query(
        status_filter_list=OPEN_ORDER_STATUSES, trd_env=env, acc_id=acc_id,
        order_market=TRD_MARKET_ENUM[market], refresh_cache=True,
    )
    if ret != 0:
        return err(f'get-orders rejected by OpenD: {df}')
    orders = []
    for _, row in df.iterrows():
        code = text_of(cell(row, 'code'))
        orders.append({
            # 执行核对账只读前四个（适配器按 clientOrderId/remark 严格匹配）
            'orderId': text_of(cell(row, 'order_id')),
            'code': code,
            'orderStatus': text_of(cell(row, 'order_status')),
            'remark': text_of(cell(row, 'remark')),
            # 以下为附加列（主仓 connector-futu 的挂单列表面要用；执行核忽略）
            'stockName': text_of(cell(row, 'stock_name')),
            'trdSide': text_of(cell(row, 'trd_side')),
            'orderType': text_of(cell(row, 'order_type')),
            'qty': number_of(cell(row, 'qty')),
            'price': number_of(cell(row, 'price')),
            'dealtQty': number_of(cell(row, 'dealt_qty')),
            'dealtAvgPrice': number_of(cell(row, 'dealt_avg_price')),
            'createTime': wall_to_iso(text_of(cell(row, 'create_time')), market_tz(code))
            if text_of(cell(row, 'create_time')) else '',
        })
    return ok({'orders': orders})


def handle_cancel_order(body: dict) -> dict:
    order_id = body.get('orderId')
    if not isinstance(order_id, str) or order_id.strip() == '':
        return err('cancel-order: orderId 必填')
    env = trd_env_of(body.get('trdEnv'))
    if env is None:
        return err(f"cancel-order: trdEnv 必须是 'SIMULATE' 或 'REAL'，收到 {body.get('trdEnv')!r}")
    acc_id, problem = acc_id_of(body)
    if problem is not None:
        return err(problem)
    if acc_id == 0:
        return err('cancel-order: 必须给 accId —— 这条请求里没有 market，'
                   '而 HK / US 是两套 trd 上下文（不猜是哪个市场）')
    market = acc_markets().get(acc_id, '')
    if market == '':
        return err(f'cancel-order: accId {acc_id} 不在 OpenD 的账户表里（不猜账户）')

    ret, df = trade_ctx(market).modify_order(
        modify_order_op=ModifyOrderOp.CANCEL, order_id=order_id.strip(), qty=0, price=0,
        trd_env=env, acc_id=acc_id,
    )
    if ret != 0:
        return err(f'cancel-order rejected by OpenD: {df}')
    return ok({'orderId': order_id.strip()})


class Handler(BaseHTTPRequestHandler):
    def respond(self, body: dict, method: str, path: str, query: str = '') -> None:
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        print(f'{method} {path}{query} -> retType={body.get("retType")}', flush=True)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query)
        try:
            with lock:
                if parsed.path in TRD_PATHS:
                    body = err(POST_ONLY_MESSAGE)
                elif parsed.path == '/api/qot/get-ticker':
                    body = handle_get_ticker(q)
                elif parsed.path == '/api/qot/get-kl':
                    body = handle_get_kl(q)
                elif parsed.path == '/api/qot/get-plate-security':
                    body = ok({'securityList': []})
                else:
                    body = err(f'bridge: unsupported path {parsed.path}')
        except Exception as exc:  # noqa: BLE001 —— 桥面把一切异常折成 retType:-1
            body = err(f'{type(exc).__name__}: {exc}')
        self.respond(body, 'GET', parsed.path, f'?{parsed.query}' if parsed.query else '')

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            length = int(self.headers.get('content-length') or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b''
        try:
            body = json.loads(raw.decode('utf-8')) if raw else {}
            if not isinstance(body, dict):
                raise ValueError('body 必须是 JSON 对象')
        except Exception as exc:  # noqa: BLE001 —— 坏请求体一律折成 retType:-1
            self.respond(err(f'bridge: malformed JSON body ({exc})'), 'POST', parsed.path)
            return
        try:
            with lock:
                if parsed.path == '/api/trd/place-order':
                    out = handle_place_order(body)
                elif parsed.path == '/api/trd/get-orders':
                    out = handle_get_orders(body)
                elif parsed.path == '/api/trd/cancel-order':
                    out = handle_cancel_order(body)
                else:
                    out = err(f'bridge: unsupported path {parsed.path}')
        except Exception as exc:  # noqa: BLE001 —— 桥面把一切异常折成 retType:-1
            out = err(f'{type(exc).__name__}: {exc}')
        self.respond(out, 'POST', parsed.path)

    def log_message(self, *args) -> None:  # 静默默认访问日志（保留上方业务日志）
        return


if __name__ == '__main__':
    print(f'futu-openapi-bridge listening on {LISTEN_HOST}:{LISTEN_PORT} -> OpenD {OPEND_HOST}:{OPEND_PORT}', flush=True)
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
