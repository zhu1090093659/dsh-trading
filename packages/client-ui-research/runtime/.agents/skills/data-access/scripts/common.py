"""data-access 公共模块:代码归一化 / 市场判定 / 东财限流(跨进程文件锁)/ evidence 构造 / 原子落盘 / 统一输出。

所有取数脚本共享本模块。设计原则(对应 研究宪法 §1 §4 §5):
- 失败出声:任何端点失败都记录到 errors,不伪造值;主源失败走备源并标注;关键字段缺失 = partial,不是 ok。
- 每条证据带齐契约字段:id/symbol/market/field/value/unit/currency/period/as_of/source/endpoint/fetched_at/adjustment/raw_ref。
- 原始响应原样落盘(raw/),文件名唯一(微秒 + pid + 随机)且排他创建(O_EXCL),绝不覆盖;SDK 拼装的中间产物以 extracted_ 前缀标明,不冒充原始响应。
- 原子写入:临时文件 → fsync → 替换。
- 东财请求跨进程串行(文件锁覆盖整个请求生命周期 + 持久化上次请求时间,任一时刻最多一个在途),403 不重试。
退出码:0 = ok(主源成功且关键字段齐)/ 2 = partial(走了备源 / 关键字段缺失 / 僵尸报价)/ 3 = failed(关键数据全部失败或输入非法)。
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import random
import re
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TZ_SH = timezone(timedelta(hours=8))
EM_MIN_INTERVAL = 1.0  # 东财两次请求最小间隔(秒),跨进程生效
EM_LOCK_PATH = os.path.join(tempfile.gettempdir(), "vibe-research-agent-eastmoney.lock")

_TICKER_RE = re.compile(r"^(?:(sh|sz|bj)(\d{6})|(\d{6})(?:\.(sh|sz|bj))?)$", re.IGNORECASE)


def now_iso() -> str:
    return datetime.now(TZ_SH).isoformat(timespec="seconds")


def today_str() -> str:
    return datetime.now(TZ_SH).strftime("%Y-%m-%d")


def natural_market(digits: str) -> str:
    """6 位码自然归属(小写 sh/sz/bj)。000xxx 按深市个股(沪市 000 段只有指数,个股接口不服务)。"""
    if digits.startswith("92") or digits[:2] in ("43", "83", "87"):
        return "bj"
    if digits[0] in ("5", "6", "9"):
        return "sh"
    return "sz"


def norm_ticker(code: str, stock_only: bool = True) -> tuple[str, str]:
    """任意写法 → (纯 6 位, 市场 SH|SZ|BJ)。解析失败抛 ValueError,绝不猜。
    stock_only=True(本 skill 全部脚本默认):拒绝显式指数写法(SH000xxx)与矛盾写法(BJ000xxx、SZ600xxx)。"""
    raw = str(code).strip()
    m = _TICKER_RE.match(raw)
    if not m:
        raise ValueError(f"无法解析股票代码 {code!r};支持 600519 / SH600519 / 600519.SH(前后缀二选一)")
    digits = m.group(2) or m.group(3)
    explicit = (m.group(1) or m.group(4) or "").lower()
    nat = natural_market(digits)
    if explicit:
        if digits.startswith("000"):
            if explicit == "bj":
                raise ValueError(f"{code!r} 市场标识与号段矛盾:000xxx 不属北交所")
            if explicit == "sh" and stock_only:
                raise ValueError(f"{code!r} 指向沪市指数而非个股(沪市无 000xxx 个股),本接口只服务个股;深市个股请传 sz{digits}")
        elif explicit != nat:
            raise ValueError(f"{code!r} 市场标识与号段矛盾:{digits} 属 {nat} 市")
    market = explicit or nat
    return digits, market.upper()


def tencent_code(digits: str, market: str) -> str:
    return market.lower() + digits


def em_secid(digits: str, market: str) -> str:
    return ("1." if market == "SH" else "0.") + digits


def bs_code(digits: str, market: str) -> str:
    if market == "BJ":
        raise ValueError("baostock 不支持北交所代码")
    return market.lower() + "." + digits


def bs_paging_error(rs) -> Optional[str]:
    """baostock 读完 `while rs.next()` 之后调:没读完整就返回原因,读完整返回 None。

    SDK 每页 2000 行(BAOSTOCK_PER_PAGE_COUNT),翻页失败有两种都不抛异常、next() 只返回 False:
    ① 服务端回错(如别的会话把登录挤掉「用户未登录」):只改 error_code;
    ② 取下一页时网络异常:SDK 的 send_msg 打印后返回 None,error_code 还是 "0",rs.data 停在上一页的满页。
       正常读完时最后一页不满,或者下一页回空、rs.data 变成 [] —— 读完还是满页 ⇒ 下一页没取到。
    """
    if rs.error_code != "0":
        return f"{rs.error_code} {rs.error_msg}"
    try:
        from baostock.common.contants import BAOSTOCK_PER_PAGE_COUNT as page
    except ImportError:
        page = 2000
    data = getattr(rs, "data", None)
    if isinstance(data, list) and data and len(data) == page:
        return "下一页没有回应(网络异常,SDK 没有报错)"
    return None


# ---------------- 东财限流(跨进程) ----------------
_em_sessions: dict = {}
EM_PUSH2_HOSTS = ("push2delay.eastmoney.com", "push2.eastmoney.com")
EM_PUSH2HIS_HOSTS = ("push2his.eastmoney.com", "push2delay.eastmoney.com")


def _em_session(trust_env: bool):
    import requests  # 延迟导入,纯 urllib 脚本不依赖 requests

    if trust_env not in _em_sessions:
        s = requests.Session()
        s.trust_env = trust_env
        s.headers.update({"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
        _em_sessions[trust_env] = s
    return _em_sessions[trust_env]


def _lock_em_file(lf) -> None:
    """Block until the one-byte EastMoney lock is held on this platform."""
    # 🔴 拿到锁之前不许往文件里写任何东西。Windows 的字节锁是强制的:别的进程锁着第 0 字节时,
    #    往那里写会直接 PermissionError。原来空文件时先补写一个 "0" 再上锁,两个进程同时起跑
    #    (或别人在锁里刚 truncate、还没写回时间戳)就会撞上,这一路取数报错(CI Windows 偶发)。
    #    Windows 允许锁文件末尾之外的字节,空文件直接锁第 0 字节即可;空内容在读时间戳时按 0 处理。
    lf.seek(0)
    if sys.platform != "win32":
        fcntl.flock(lf, fcntl.LOCK_EX)
    else:
        # msvcrt.locking locks from the current file position. LK_LOCK retries for
        # roughly ten seconds, so repeat only the documented lock-contention errors
        # to preserve the POSIX blocking semantics for requests that take longer.
        while True:
            try:
                msvcrt.locking(lf.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError as exc:
                deadlock = getattr(errno, "EDEADLOCK", errno.EDEADLK)
                if exc.errno not in {errno.EACCES, errno.EDEADLK, deadlock}:
                    raise


def _unlock_em_file(lf) -> None:
    lf.seek(0)
    if sys.platform == "win32":
        msvcrt.locking(lf.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(lf, fcntl.LOCK_UN)


def _em_serial(fn):
    """跨进程**串行**执行一次东财请求:文件锁覆盖"等间隔 → 发请求 → 收响应 → 写时间戳"全程,
    并行启动的多个脚本在锁上排队,任一时刻最多一个东财请求在途(手册铁律:绝不对东财并发)。"""
    with open(EM_LOCK_PATH, "a+") as lf:
        _lock_em_file(lf)
        try:
            lf.seek(0)
            try:
                last = float(lf.read().strip() or 0)
            except ValueError:
                last = 0.0
            wait = EM_MIN_INTERVAL - (time.time() - last)
            if wait > 0:
                time.sleep(wait + random.uniform(0.1, 0.5))
            try:
                return fn()
            finally:
                lf.seek(0)
                lf.truncate()
                lf.write(str(time.time()))
                lf.flush()
        finally:
            _unlock_em_file(lf)


def em_get(url: str, params: Optional[dict] = None, headers: Optional[dict] = None, timeout: int = 15):
    """东财统一入口:跨进程串行(锁覆盖整个请求)+ 会话复用 + UA/Referer;403 不重试。
    先按系统代理设置请求,遇连接类错误再直连重试一次(东财单域经代理常断连);每次重试同样排队。"""
    import requests

    try:
        return _em_serial(lambda: _em_session(True).get(url, params=params, headers=headers, timeout=timeout))
    except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError):
        return _em_serial(lambda: _em_session(False).get(url, params=params, headers=headers, timeout=timeout))


def em_multi_host(hosts: tuple, path: str, params: Optional[dict] = None, timeout: int = 15):
    """按 hosts 顺序请求同一 path,返回 (response, host);全失败抛最后一个异常。"""
    last: Optional[Exception] = None
    for h in hosts:
        try:
            r = em_get(f"https://{h}{path}", params=params, timeout=timeout)
            if r.status_code == 200:
                return r, h
            last = RuntimeError(f"{h} HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001 — 轮询下一主机
            last = e
    raise last if last else RuntimeError("无可用东财主机")


# ---------------- 落盘 ----------------
def atomic_write(path: str, data: bytes) -> None:
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path: str, obj: Any) -> None:
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"))


def save_raw(out_dir: Optional[str], source: str, endpoint: str, content: bytes, ext: str = "txt",
             kind: str = "raw") -> dict:
    """落盘到 <out_dir>/raw/<kind>_<source>_<endpoint>_<微秒时间戳>_<pid>_<rand>.<ext>,文件名唯一、绝不覆盖。
    kind="raw" = 传输层原始响应;kind="extracted" = SDK / DataFrame 拼装的中间产物(不冒充原始响应)。
    返回 {raw_ref, sha256, kind}。out_dir 为空则只算 hash。"""
    sha = hashlib.sha256(content).hexdigest()
    if not out_dir:
        return {"raw_ref": None, "sha256": sha, "kind": kind}
    stamp = datetime.now(TZ_SH).strftime("%Y%m%dT%H%M%S%f")
    safe_ep = re.sub(r"[^A-Za-z0-9_.-]+", "_", endpoint)[:60]
    prefix = "" if kind == "raw" else "extracted_"
    os.makedirs(os.path.join(out_dir, "raw"), exist_ok=True)
    for _ in range(5):
        name = f"{prefix}{source}_{safe_ep}_{stamp}_{os.getpid()}_{random.randrange(16**4):04x}.{ext}"
        # 🔴 raw_ref 是交换契约,固定用 `/`(计算库只认 raw/xxx);只有真实磁盘路径才用系统分隔符。
        #    以前用 os.path.join,Windows 上产出 raw\xxx,传给计算库当场被拒(审计 B8)
        rel = f"raw/{name}"
        full = os.path.join(out_dir, "raw", name)
        try:
            fd = os.open(full, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)  # 排他创建:已存在即失败,绝不覆盖
        except FileExistsError:
            continue
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        return {"raw_ref": rel, "sha256": sha, "kind": kind}
    raise RuntimeError("raw 文件名连续冲突,放弃写入")


# ---------------- evidence ----------------
def evidence(*, script: str, symbol: str, market: str, field: str, value: Any, unit: str, period: str,
             source: str, endpoint: str, raw_ref: Optional[str], currency: str = "CNY",
             as_of: Optional[str] = None, fetched_at: Optional[str] = None,
             adjustment: str = "not_applicable", note: Optional[str] = None,
             record_key: Optional[str] = None) -> dict:
    """构造一条契约证据。id 由 script|source|endpoint|symbol|field|period|record_key 确定性生成:
    同一脚本同输入同 id(便于多次运行比对);不同脚本抓同一事实是两条证据(各自的快照);
    同日多条记录(公告 / 多篇研报)必须传 record_key(如 art_code / infoCode)避免撞 id。"""
    key = "|".join([script, source, endpoint, symbol, field, str(period), record_key or ""])
    eid = "ev-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    rec = {
        "id": eid, "symbol": symbol, "market": market, "field": field, "value": value,
        "unit": unit, "currency": currency, "period": period,
        "as_of": as_of or today_str(), "source": source, "endpoint": endpoint,
        "fetched_at": fetched_at or now_iso(), "adjustment": adjustment, "raw_ref": raw_ref,
    }
    if note:
        rec["note"] = note
    if record_key:
        rec["record_key"] = record_key
    return rec


# ---------------- CLI / 输出 ----------------
def base_parser(desc: str) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=desc)
    p.add_argument("--symbol", required=True, help="股票代码:300308 / SZ300308 / 300308.SZ")
    p.add_argument("--out-dir", default=None, help="运行目录(.local/runs/<run-id>);给定则原始响应落盘到其 raw/")
    p.add_argument("--timeout", type=int, default=15)
    return p


def result_skeleton(script: str, symbol: str, market: str) -> dict:
    return {"script": script, "symbol": symbol, "market": market, "status": "failed",
            "fetched_at": now_iso(), "primary_source": None, "used_sources": [],
            "evidence": [], "extra": {}, "errors": [], "missing": []}


def lib_versions(*names: str) -> dict:
    """记录运行时依赖版本(provenance)。"""
    out = {"python": sys.version.split()[0]}
    for n in names:
        try:
            mod = __import__(n)
            out[n] = getattr(mod, "__version__", "?")
        except Exception:  # noqa: BLE001
            out[n] = "not_installed"
    return out


def finish(result: dict, out_dir: Optional[str] = None) -> None:
    """按 status 设退出码并输出 JSON;若给 out_dir,同时落盘到 <out_dir>/fetch/<script>.json。"""
    status = result.get("status", "failed")
    if out_dir:
        atomic_write_json(os.path.join(out_dir, "fetch", f"{result['script']}.json"), result)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    sys.exit({"ok": 0, "partial": 2}.get(status, 3))


_HOME_USER_RE = re.compile(r"(/Users/|/home/)([^/\\\"'\s:]+)")
# 真实 Windows 路径是一根反斜杠；repr/JSON 诊断中也可能出现双反斜杠。
_WINDOWS_HOME_USER_RE = re.compile(r"([A-Za-z]:\\{1,2}(?i:Users)\\{1,2})([^/\\\"'\r\n:]+)")
_PRIVATE_IP_RE = re.compile(r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b")
_USERINFO_RE = re.compile(r"\b([a-z][a-z0-9+.-]*://)[^/@\s:]+:[^/@\s]*@", re.I)
_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _sec_contact_variants() -> list:
    """环境变量 VRA_SEC_CONTACT 的几种写法(原样、并空白后、repr 转义后),长的先遮;太短的不遮,免得误伤正文。"""
    raw = os.environ.get("VRA_SEC_CONTACT", "").strip()
    if not raw:
        return []
    forms = {raw, " ".join(raw.split()), repr(raw)[1:-1]}
    return sorted((f for f in forms if len(f) >= 6), key=len, reverse=True)


def redact_text(text: str) -> str:
    """
    错误 / 诊断文本的脱敏。

    🔴 全审 r3-P1-5 / P2-6:信封的 errors 与 extra.traceback_tail **原样进产物、并经 MCP / API 回传**。
       实际漏过的东西:`VRA_SEC_CONTACT` 里的**真名与邮箱**(SEC 要求 UA 带联系方式,拒绝时会把它拼进
       错误消息)、第三方 SDK traceback 里的 URL token / 代理地址 / 主目录模块路径。
    ⚠️ 只在**写进信封时**脱敏,不改动实际请求 —— 与 core/retrieval 那次同一条纪律:
       脱敏必须发生在副作用之后、外传之前;拿脱敏后的值去发请求会 403。
    ⚠️ 纵深防御,不是安全边界:自由文本里的敏感信息枚举不干净。
    """
    if not text:
        return text
    out = text
    for v in _sec_contact_variants():
        out = out.replace(v, "[REDACTED_CONTACT]")
    out = _USERINFO_RE.sub(r"\1[REDACTED_USERINFO]@", out)
    out = _KEY_RE.sub("[REDACTED_KEY]", out)
    out = _EMAIL_RE.sub("[REDACTED_EMAIL]", out)
    out = _HOME_USER_RE.sub(r"\1[USER]", out)
    out = _WINDOWS_HOME_USER_RE.sub(r"\1[USER]", out)
    return _PRIVATE_IP_RE.sub("[PRIVATE_IP]", out)


def record_error(result: dict, source: str, endpoint: str, err: Exception) -> None:
    result["errors"].append({"source": source, "endpoint": endpoint,
                             "error": redact_text(f"{type(err).__name__}: {str(err)[:200]}"), "at": now_iso()})


def parse_symbol_or_exit(symbol: str, script: str, out_dir: Optional[str] = None) -> tuple[str, str]:
    """解析代码;失败时按契约输出 failed JSON(给了 out_dir 也落盘)并以退出码 3 结束。"""
    try:
        return norm_ticker(symbol, stock_only=True)
    except ValueError as e:
        res = result_skeleton(script, str(symbol), "")
        record_error(res, "input", "symbol", e)
        finish(res, out_dir)
        raise SystemExit(3)  # finish 已 exit,此行仅作类型安全


def to_float(v: Any) -> Optional[float]:
    try:
        if v is None or v == "" or v == "--" or v == "-":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


class quiet_stdout:
    """临时把 stdout 重定向到 stderr:baostock 等库会往 stdout 打印 login success,会污染 JSON 输出。"""

    def __enter__(self):
        self._saved = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *exc):
        sys.stdout = self._saved
        return False
