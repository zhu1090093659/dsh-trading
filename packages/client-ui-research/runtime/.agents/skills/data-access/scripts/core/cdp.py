"""**Core 浏览器通道(CDP)**:接管本机已开的 Chrome 取渲染后的页面。**只读**。

为什么是 CDP 而不是捆绑浏览器:不在代码发行里额外带一套浏览器;能用上用户已登录的会话;
反爬站点只有真实浏览器过得去。CDP 是 WebSocket + JSON,标准库就能讲,**零新增依赖**。

⚠️ 它操作的是**用户真实浏览器与真实登录态**,所以边界必须写死在代码里:
- **只读**:打开 URL、等渲染、取正文。不点击 / 不填表 / 不提交 / 不下载。
- **只连本机回环**:HTTP 端点与 WebSocket 端点(含端口)都要校验(见 `_assert_loopback`)。
- **只开 http/https,且拒绝内网与本地文件**:URL 常常来自**不可信的搜索结果**,
  不设限就等于把 `file:///etc/passwd`、路由器管理页、云元数据服务交给它打开。
- **可选增强,不是默认路径**:默认取页走零配置的 r.jina.ai(见 `core/retrieval.py`)。

## 关于"只访问公网目标"这条边界能做到什么程度(诚实说明)

四道防线,**强度依次递减,都不是密不透风的边界**:
1. **限协议 + 拒字面内网 IP** —— 始终生效,与环境无关,最可靠。判据是显式网段(`_is_forbidden_ip`)。
2. **所有请求发出前拦截**(`Fetch.requestPaused`)—— 首个请求、服务端跳转、脚本跳转、iframe,
   以及图片 / 脚本 / XHR / fetch 等子资源,都在**发包之前**过一遍 1 和 4,不合格就让 Chrome 放弃这条请求。
   只做"导航后再查最终 URL"的话,内网请求已经发出去了(GET 接口的副作用也已发生,审计 B2);
   只拦页面级请求的话,公网页面里一张 `<img src="http://127.0.0.1/...">` 照样打到内网(审计第二轮 B2)。
   页面级请求被拦 = 这一页不取;子资源被拦只是那张图 / 那个请求没了,正文照取。
   Fetch 拦截管不到的 WebSocket / WebRTC / WebTransport,在页面脚本运行之前就换成抛错的入口(读正文用不到)。
   ⚠️ 残留:Worker 里自己建的 WebSocket 不在上面这一步的覆盖范围内。
3. **导航后用最终 URL 再验一次** —— 兜底。
4. **域名预解析** —— 只在解析器可信时才有意义;走 fake-IP 代理的机器上会被主动跳过
   (见 `_assert_resolves_public`,本机实测过)。

🔴 为什么都不是边界:Chrome 自己会重新解析 DNS,攻击者可以让两次解析结果不同
(DNS rebinding),这是 TOCTOU,在本进程内无法根治。**这是纵深防御,不要当成"已经安全了"** ——
真要硬隔离得让浏览器跑在受限网络环境里。

## 已知限制:`socket.getaddrinfo()` 没有绝对超时

WebSocket 与 HTTP 两条读取路径都已收口到绝对 deadline,但**域名解析这一步没有** ——
Python 标准库不给 `getaddrinfo` 超时参数,唯一办法是全局 `setdefaulttimeout()`(有副作用)
或另起线程,对一个**可选增强通道**不划算。⇒ 系统解析器 / VPN DNS / mDNS 后端卡死时,
本模块**可能同步阻塞数十秒**。这是已知限制,**不要写成"不存在挂死路径"**(Codex r5)。

🔴 与产品证据纪律的关系:取回的是**外部不可信文本**,与搜索结果同级。
必须落 raw、标注来源与时间,按"线索不是事实"处理。**不要因为"是浏览器取的"就当成更可信。**
⚠️ 且**宁可当场报错,也不静默返回可疑内容** —— 导航超时 / 拿到空正文 / 最终落地页越界
都会抛错,因为"看着成功但其实是旧页面、错误页或拦截页"会变成一条错误的证据,比失败更糟。
`fetch_rendered` 返回 `(正文, 最终URL)`,**最终 URL 才是这段正文的出处** —— 发生重定向时
用请求 URL 记账就是张冠李戴(Codex core-retrieval-r2a P3)。
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import socket
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

DEBUG_HOST = os.environ.get("VRA_CDP_HOST", "127.0.0.1")
DEBUG_PORT = int(os.environ.get("VRA_CDP_PORT", "9222"))
NAV_TIMEOUT_S = 25
CALL_TIMEOUT_S = 20
#: 单帧 / 单消息 / 握手头 / URL 的上限。没有上限时,对端声明个超大长度就能把内存吃光。
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_MESSAGE_BYTES = 32 * 1024 * 1024
MAX_HANDSHAKE_BYTES = 64 * 1024
MAX_URL_CHARS = 2048
MAX_HTTP_BYTES = 4 * 1024 * 1024
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class CdpError(RuntimeError):
    pass


class CdpHttpError(CdpError):
    """带 HTTP 状态码 —— 用于区分"方法不被支持"(可换方法重试)与"结果未知"(**不可重试**)。"""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def endpoint_hint() -> str:
    """给用户看的启动提示 —— 报错时带上,别让人对着 'connection refused' 猜。"""
    return (f"未连上本机 Chrome 调试端口 {DEBUG_HOST}:{DEBUG_PORT}。"
            f"CDP 是**可选增强**,默认取页走零配置的 r.jina.ai,不配也能用。"
            f"要启用:用 --remote-debugging-port={DEBUG_PORT} 启动 Chrome(会用到你已登录的会话)。")


# ---------- 地址边界 ----------

def _is_loopback(host: str) -> bool:
    if host in ("localhost", "::1"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _assert_loopback(host: str, what: str) -> None:
    """调试端点**只允许回环**。`VRA_CDP_HOST` 配错、或端点返回一个远端 ws 地址,
    都会把这个"只读本机浏览器"的通道变成连去别处(r1 P1)。"""
    if not _is_loopback(host):
        raise CdpError(f"{what} 指向非本机地址 {host!r}:CDP 只允许连本机回环调试端口,拒绝。")


#: 不是公网的网段。🔴 **显式列出**,不用 `is_private` 一类属性:那些属性的覆盖面随 Python 版本变,
#: 3.11 上 100.64.0.0/10(运营商共享地址段)一个都不算,内部服务照样连得到(审计 B1)。
_V4_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"))
#: 6to4(2002::/16)与 IETF 协议段(含 Teredo)整段拒:它们能把任意 IPv4 包进来
_V6_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    "::/128", "::1/128", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16",
    "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"))
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_V4_COMPAT = ipaddress.ip_network("::/96")


def _is_forbidden_ip(ip) -> bool:
    if ip.version == 6:
        if ip.ipv4_mapped is not None:                      # ::ffff:a.b.c.d 按里面那个 IPv4 判
            return _is_forbidden_ip(ip.ipv4_mapped)
        if ip in _NAT64:
            return _is_forbidden_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if ip in _V4_COMPAT:                                # 已废弃的 ::a.b.c.d,整段拒
            return True
        return any(ip in n for n in _V6_BLOCKED)
    return any(ip in n for n in _V4_BLOCKED)


def assert_fetchable_url(url: str, *, what: str = "URL") -> None:
    """URL 常来自**不可信搜索结果** —— 只放行 http/https 的公网地址。

    ⚠️ 见模块开头:域名预解析是**纵深防御不是边界**(Chrome 会自己再解析一次,存在 DNS rebinding)。
    非规范 IP 写法(整数 / 八进制)`ipaddress` 认不出,会落到 DNS 这条路 —— 恰好也被解析检查拦住。
    """
    if len(url) > MAX_URL_CHARS:
        raise CdpError(f"{what} 过长({len(url)} 字符),拒绝")
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https"):
        raise CdpError(f"只允许 http/https,拒绝 {p.scheme or '空'} 协议:{url[:80]}")
    host = (p.hostname or "").strip("[]")
    if not host:
        raise CdpError(f"{what} 没有主机名:{url[:80]}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        _assert_resolves_public(host, url, what)
        return
    if _is_forbidden_ip(ip):
        raise CdpError(f"拒绝访问内网 / 保留地址 {ip}:{url[:80]}")


#: **fake-IP DNS 的签名网段。** Clash / Surge 这类代理默认把**所有**域名映射进 198.18.0.0/16
#: (少数配置用 240.0.0.0/4),再在代理层按域名转发。这不是"目标在内网",而是
#: **解析器根本没在告诉我们 Chrome 会连去哪** —— 见 `_assert_resolves_public` 的说明。
FAKE_IP_NETS = (ipaddress.ip_network("198.18.0.0/15"), ipaddress.ip_network("240.0.0.0/4"))


def _looks_like_fake_ip(ip) -> bool:
    return any(ip.version == n.version and ip in n for n in FAKE_IP_NETS)


def _assert_resolves_public(host: str, url: str, what: str) -> None:
    """域名预解析检查。**只在解析器可信时才有意义。**

    🔴 本机实测踩到的坑:`example.com` 解析成 `198.18.0.98` —— 这台机器走 fake-IP 代理。
    如果照"落在私有段就拒绝"办,**所有网页访问会被一律拦死**,而用这类代理的用户
    恰恰是主要受众。更要紧的是:在 fake-IP 下本地解析结果与 Chrome 实际连接的地址无关,
    这个检查**没有任何信息量**,它没资格假装在保护什么 ⇒ 识别出这种解析器就**跳过**,
    把判断交给始终生效的那两道:字面 IP 拒绝、以及导航后对最终 URL 的复检。

    ⚠️ 即便解析器可信,这一步也只是纵深防御:Chrome 会自己再解析一次(DNS rebinding 是 TOCTOU)。
    """
    if host.lower() == "localhost" or host.lower().endswith(".localhost"):
        raise CdpError(f"拒绝访问本机地址:{url[:80]}")
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise CdpError(f"{what} 域名无法解析({type(e).__name__}):{url[:80]}") from None
    resolved = []
    for info in infos:
        try:
            resolved.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    # 🔴 必须是**全部**结果都落在 fake-IP 段才跳过。写成"任意一条"就等于给了绕过口子:
    #    攻击者同时返回 198.18.0.10 与 127.0.0.1,整组检查被跳过而 Chrome 可能挑后者
    #    (Codex core-retrieval-r3 P1 —— 这是我上一轮修复自己引入的洞)。
    if resolved and all(_looks_like_fake_ip(ip) for ip in resolved):
        return                     # 解析器在编地址 —— 无信息可用,不假装做了检查
    for ip in resolved:
        if _is_forbidden_ip(ip):
            # 任何一条解析结果落在内网就整体拒绝:轮询 DNS 里只要有一条是内网就够
            raise CdpError(f"{what} 的域名 {host} 解析到内网地址 {ip},拒绝:{url[:80]}")


def _request_blocked_reason(url: str, cache: Optional[dict] = None) -> Optional[str]:
    """请求发出前的地址判定(给 `Fetch.requestPaused` 用):可以放行返回 None,否则返回拒绝原因。
    data: / blob: / about: 不走网络,放行;其余照 `assert_fetchable_url` 的规则。
    `cache`:同一次取页里按(协议, 主机, 是否超长)记住结论 —— 子资源动辄上百个,每个都解析一次 DNS 太慢。"""
    p = urllib.parse.urlparse(url)
    if p.scheme in ("data", "blob", "about"):
        return None
    key = (p.scheme, (p.hostname or "").lower(), len(url) > MAX_URL_CHARS)
    if cache is not None and key in cache:
        return cache[key]
    try:
        assert_fetchable_url(url, what="请求地址")
        why = None
    except CdpError as e:
        why = str(e)
    if cache is not None:
        cache[key] = why
    return why


#: Fetch 拦截管不到的出站通道:页面(含 iframe)脚本运行之前换成抛错的构造器
_NO_SOCKETS_JS = (
    "(() => { for (const k of ['WebSocket', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {"
    " try { Object.defineProperty(window, k, { value: function () { throw new Error('blocked'); },"
    " configurable: false, writable: false }); } catch (e) {} } })();"
)


def _http_json(path: str, timeout: int = 5, method: str = "GET"):
    _assert_loopback(DEBUG_HOST, "VRA_CDP_HOST")
    host = f"[{DEBUG_HOST}]" if ":" in DEBUG_HOST else DEBUG_HOST   # IPv6 字面量要方括号
    url = f"http://{host}:{DEBUG_PORT}{path}"
    deadline = time.monotonic() + timeout
    try:
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # 🔴 `timeout` 只约束**单次**阻塞操作,不约束整个响应的读取:对端每隔不到 timeout
            #    滴一个字节就能无限拖住(`is_available()` 号称 2 秒探测也会长期不返回)。
            #    与 WebSocket 侧同一类问题,同样用**绝对截止**收口(Codex core-retrieval-r4 P1)。
            #    4MB 上限管的是内存,管不了时间 —— 两个都要有。
            read1 = getattr(resp, "read1", None) or resp.read
            chunks, size = [], 0
            while True:
                if time.monotonic() > deadline:
                    raise CdpHttpError(f"读取调试端点响应超时({timeout}s),拒绝")
                # 🔴 必须用 `read1`:`read(n)` 在 http.client 内部会**循环凑满 n 字节**,
                #    于是 deadline 只能在两次 read 之间检查,慢速滴流照样打不断(r5)。
                chunk = read1(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_HTTP_BYTES:
                    raise CdpHttpError(f"调试端点响应超过 {MAX_HTTP_BYTES} 字节,拒绝")
        got = json.loads(b"".join(chunks))
        if not isinstance(got, dict):
            # WebSocket 侧已校验类型,HTTP 侧不校验就会在 `tab.get("id")` 抛 AttributeError
            raise CdpHttpError(f"调试端点返回的不是 JSON 对象(收到 {type(got).__name__})")
        return got
    except urllib.error.HTTPError as e:
        raise CdpHttpError(f"调试端点返回 HTTP {e.code}({method} {path})", status=e.code) from None
    except CdpHttpError:
        raise                      # 自己抛的别再包一层 —— 会把准确原因换成"连不上"的通用提示
    except Exception as e:  # noqa: BLE001 — 连不上是最常见情形,要给能懂的提示
        raise CdpHttpError(f"{endpoint_hint()}(原始错误 {type(e).__name__}: {str(e)[:80]})") from None


# ---------- 极简 WebSocket 客户端(只够讲 CDP,但按 RFC 6455 正确处理帧)----------

class _Ws:
    """够用且正确:校验握手 accept、处理分片与控制帧、有帧长上限与绝对超时。

    🔴 初版只读了长度就当 JSON 解 —— 忽略 opcode / FIN / 控制帧,也不支持分片;
    Chrome 会发 ping,而**页面正文恰恰是大消息、一定会分片**(r1 P1)。
    🔴 二版又把掩码键当成 payload 的前 4 字节 —— 掩码键在**长度字段之后、payload 之前**
    且**不计入长度**,那样会少读 4 字节、此后整条连接错帧(r2a P1)。
    而按 RFC,服务端本就**不得**加掩码,客户端应直接失败 —— 所以现在是拒绝而不是"容错"。
    """

    #: 本次操作的绝对截止(`time.monotonic()` 刻度)。**每次 recv / send 之前都按它重算 socket 超时**。
    #: 🔴 只在进 `_read_frame` 前查一次是不够的:`_read(n)` 内部可以循环 recv,对端每 4 秒滴一点数据
    #: 就能让每次 recv 都不超时,而整体远远超出调用预算(Codex core-retrieval-r3 P2)。
    _deadline: float = 0.0

    def __init__(self, ws_url: str, timeout: int = NAV_TIMEOUT_S) -> None:
        p = urllib.parse.urlparse(ws_url)
        if p.scheme != "ws":
            raise CdpError(f"只支持本机 ws:// 调试端点,收到 {ws_url[:48]!r}")
        _assert_loopback((p.hostname or ""), "调试端点返回的 WebSocket 地址")
        port = p.port or 80          # 🔴 不带端口时默认 80,不能跳过检查(r2a P1-3)
        if port != DEBUG_PORT:
            raise CdpError(f"WebSocket 端口 {port} 与已批准的调试端口 {DEBUG_PORT} 不一致,拒绝")
        self.buf = b""
        self._deadline = time.monotonic() + timeout
        try:
            self.s = socket.create_connection((p.hostname, port), timeout=timeout)
        except OSError as e:          # 连接被拒 / 超时也要走 CdpError,别破坏错误契约(r3 P2)
            raise CdpError(f"连接本机调试端口失败({type(e).__name__}):{endpoint_hint()}") from None
        try:                          # 构造期间任何失败都要关掉 socket —— 此时外层还拿不到 self(r2a P2-1)
            self._handshake(p)
        except BaseException:
            try:
                self.s.close()
            except OSError:
                pass
            raise

    def _handshake(self, p) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        path = (p.path or "/") + (f"?{p.query}" if p.query else "")   # 丢掉 query 会连错资源
        try:
            self._arm()
            self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {p.netloc}\r\nUpgrade: websocket\r\n"
                            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                            f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        except OSError as e:
            raise CdpError(f"CDP 握手发送失败({type(e).__name__})") from None
        buf = b""
        while b"\r\n\r\n" not in buf:
            try:
                self._arm()
                chunk = self.s.recv(4096)
            except OSError as e:
                raise CdpError(f"CDP 握手读取失败({type(e).__name__})") from None
            if not chunk:
                raise CdpError("CDP 握手时连接被关闭")
            buf += chunk
            if len(buf) > MAX_HANDSHAKE_BYTES:   # 收完再判,否则末轮能多收 4096 字节(r3 P3)
                raise CdpError("CDP 握手响应头超长,拒绝")
        head, _, rest = buf.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        if b" 101 " not in lines[0]:
            raise CdpError(f"CDP 握手失败:{lines[0][:80]!r}")
        hdr: dict[bytes, bytes] = {}
        for ln in lines[1:]:
            k, _, v = ln.partition(b":")
            hdr[k.strip().lower()] = v.strip()
        conn_tokens = {t.strip().lower() for t in hdr.get(b"connection", b"").split(b",")}
        if hdr.get(b"upgrade", b"").lower() != b"websocket" or b"upgrade" not in conn_tokens:
            raise CdpError("CDP 握手响应缺 Upgrade/Connection 头,不是合法的 WebSocket 端点")
        want = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest())
        if hdr.get(b"sec-websocket-accept", b"") != want:
            raise CdpError("CDP 握手 Sec-WebSocket-Accept 不匹配 —— 对端不是真正的 WebSocket 服务")
        self.buf = rest          # 🔴 握手响应之后可能已粘了第一帧,必须留给帧解析器(否则首帧丢失)

    # -- 底层读写 --
    def _arm(self) -> None:
        """按绝对截止重算 socket 超时。**每次 recv / sendall 之前都要调**。"""
        left = self._deadline - time.monotonic()
        if left <= 0:
            raise CdpError("CDP 操作超时")
        self.s.settimeout(min(left, 5.0))

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            try:
                self._arm()
                c = self.s.recv(65536)
            except OSError as e:     # socket 超时 / 断开一律转成 CdpError,保持错误契约一致(r2a P1-2)
                raise CdpError(f"CDP 读取失败({type(e).__name__})") from None
            if not c:
                raise CdpError("CDP 连接被关闭")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode: int, data: bytes) -> None:
        n = len(data)
        if n > MAX_FRAME_BYTES:
            raise CdpError(f"待发送帧 {n} 字节超过上限,拒绝")
        head = bytes([0x80 | opcode])
        mask = os.urandom(4)
        if n < 126:
            head += struct.pack("!B", 0x80 | n)
        elif n < (1 << 16):
            head += struct.pack("!BH", 0x80 | 126, n)
        else:
            head += struct.pack("!BQ", 0x80 | 127, n)
        try:
            self._arm()          # Chrome 卡死时发送缓冲会填满,sendall 也要受本次预算约束(r3 P2)
            self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        except OSError as e:
            raise CdpError(f"CDP 发送失败({type(e).__name__})") from None

    def send_json(self, payload: dict, deadline: Optional[float] = None) -> None:
        if deadline is not None:
            self._deadline = deadline
        self._send_frame(0x1, json.dumps(payload).encode())

    def _read_frame(self) -> tuple[bool, int, bytes]:
        b1, b2 = self._read(2)
        fin, rsv, opcode = bool(b1 & 0x80), b1 & 0x70, b1 & 0x0F
        if rsv:
            raise CdpError("WebSocket 帧带了未协商的 RSV 位")
        if b2 & 0x80:
            # RFC 6455:服务端发往客户端的帧**不得**加掩码,收到就该断开(而不是猜着解)
            raise CdpError("服务端发来了带掩码的帧,违反 RFC 6455,断开")
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self._read(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._read(8))[0]
            if ln >> 63:
                raise CdpError("WebSocket 64 位长度最高位必须为 0")
        if opcode in (0x8, 0x9, 0xA) and (not fin or ln > 125):
            raise CdpError("控制帧必须 FIN=1 且长度 ≤125")
        if ln > MAX_FRAME_BYTES:
            raise CdpError(f"WebSocket 帧声明长度 {ln} 超过上限 {MAX_FRAME_BYTES},拒绝(防内存耗尽)")
        return fin, opcode, self._read(ln)

    def recv_json(self, deadline: float) -> dict:
        """读一条完整消息(重组分片、就地回 pong、遇 close 抛错)。deadline 用 `time.monotonic()` 的刻度。"""
        chunks: list[bytes] = []
        total = 0
        expect_cont = False
        self._deadline = deadline                 # 交给 `_arm()`:贯穿到每一次 recv,而不只查一次
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x8:
                raise CdpError("Chrome 关闭了 CDP 连接")
            if opcode == 0x9:                       # ping → 必须回 pong,否则对端会断开
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x2:
                raise CdpError("CDP 不应发二进制帧")
            if opcode not in (0x0, 0x1):
                raise CdpError(f"未知 WebSocket opcode {opcode}")
            if opcode == 0x0 and not expect_cont:
                raise CdpError("收到没有起始帧的 continuation 帧")
            if opcode == 0x1 and expect_cont:
                # 分片未收完就来新起始帧 —— 拼下去会得到一段"能解析但内容错位"的 JSON(r2a P1-1)
                raise CdpError("分片未结束就收到新的起始帧,协议错误")
            chunks.append(payload)
            total += len(payload)
            if total > MAX_MESSAGE_BYTES:
                raise CdpError(f"CDP 消息超过上限 {MAX_MESSAGE_BYTES},拒绝")
            expect_cont = not fin
            if fin:
                try:
                    msg = json.loads(b"".join(chunks).decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as e:
                    raise CdpError(f"CDP 消息不是合法 JSON:{str(e)[:80]}") from None
                if not isinstance(msg, dict):
                    raise CdpError(f"CDP 消息不是 JSON 对象(收到 {type(msg).__name__})")
                return msg

    def close(self) -> None:
        try:
            self._deadline = time.monotonic() + 2     # 关闭不该拖住调用方
            self._send_frame(0x8, b"")
        except (OSError, CdpError):
            pass
        try:
            self.s.close()
        except OSError:
            pass


def fetch_rendered(url: str, wait_selector: Optional[str] = None) -> tuple[str, str]:
    """打开 URL,等渲染完成,返回 `(可见正文, 最终URL)`。**只读:不点击、不填表、不提交。**

    用一个**新标签页**,取完就关 —— 不动用户当前正在看的页面。
    导航失败 / 超时 / 正文为空 / 最终落地页越界,一律**抛错**,不返回可疑内容。
    """
    assert_fetchable_url(url)
    try:
        tab = _http_json("/json/new?about:blank", method="PUT")
    except CdpHttpError as e:
        # 🔴 只在"方法不被支持"时回退到 GET。连接超时 / 响应损坏属于**结果未知**,
        #    再发一次可能创建出第二个关不掉的标签页(r2a P2-2/P2-3)。
        if e.status not in (404, 405, 501):
            raise
        tab = _http_json("/json/new?about:blank", method="GET")
    tab_id = tab.get("id")
    if not tab_id:
        raise CdpError("Chrome 未返回新标签页 id,无法保证事后能关掉它,放弃")
    ws = None
    try:
        ws_url = tab.get("webSocketDebuggerUrl")
        if not ws_url:
            raise CdpError("Chrome 未返回 webSocketDebuggerUrl(调试端口可用但拒绝新建标签?)")
        ws = _Ws(ws_url)
        mid = 0
        blocked: list[str] = []
        host_verdicts: dict = {}

        def on_paused(params: dict) -> None:
            """请求发出前的拦截点:不合格就让 Chrome 放弃这条请求(不回应它,页面会一直挂着)。
            页面级请求(Document)被拦 ⇒ 整页放弃;子资源被拦 ⇒ 只是这一个请求没了。"""
            nonlocal mid
            is_doc = params.get("resourceType") == "Document"
            why = _request_blocked_reason(str((params.get("request") or {}).get("url") or ""),
                                          None if is_doc else host_verdicts)
            mid += 1
            if why:
                if is_doc:
                    blocked.append(why)
                ws.send_json({"id": mid, "method": "Fetch.failRequest",
                              "params": {"requestId": params.get("requestId"), "errorReason": "BlockedByClient"}})
            else:
                ws.send_json({"id": mid, "method": "Fetch.continueRequest",
                              "params": {"requestId": params.get("requestId")}})

        def check_blocked() -> None:
            if blocked:
                raise CdpError(f"页面要去的地址被拦截,放弃:{blocked[0][:160]}")

        def call(method: str, params: Optional[dict] = None, timeout: float = CALL_TIMEOUT_S):
            nonlocal mid
            mid += 1
            my = mid
            # 绝对截止**在发送之前**就定下:sendall 本身也可能阻塞(r2a P1-2)
            deadline = time.monotonic() + max(0.1, timeout)
            ws.send_json({"id": my, "method": method, "params": params or {}}, deadline=deadline)
            while True:
                msg = ws.recv_json(deadline)
                if msg.get("id") == my:
                    if "error" in msg:
                        raise CdpError(f"{method} 失败:{str(msg['error'])[:120]}")
                    return msg.get("result", {})
                if msg.get("method") == "Fetch.requestPaused":
                    on_paused(msg.get("params") or {})

        nav_deadline = time.monotonic() + NAV_TIMEOUT_S

        def left() -> float:                                        # 每次 call 只能用**剩余**预算,
            return max(0.1, nav_deadline - time.monotonic())        # 否则总耗时可超出 NAV_TIMEOUT 一整个 call

        call("Page.enable", timeout=left())
        # 所有请求(主页面、跳转目标、iframe、图片 / 脚本 / XHR 等子资源)一律先停在发包前,过一遍地址检查再放行。
        # 开不了拦截就整次放弃 —— 没法在发包前拦住内网地址,宁可不取(审计 B2 / 第二轮 B2)
        call("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}, timeout=left())
        call("Page.addScriptToEvaluateOnNewDocument", {"source": _NO_SOCKETS_JS}, timeout=left())
        nav = call("Page.navigate", {"url": url}, timeout=left())
        check_blocked()
        if nav.get("errorText"):
            # DNS / 连接失败会落到 chrome-error:// 页面,它**有正文** —— 不拦就成了一条错误证据
            raise CdpError(f"导航失败:{str(nav['errorText'])[:80]}({url[:60]})")

        # 🔴 判"导航完成"不能只看 readyState:刚 navigate 时读到的可能还是 about:blank 的 complete;
        #    重定向链里的中间页也会先到 interactive。所以要求 complete,或 interactive 且 URL 连续两次相同。
        final_url = ""
        prev_href = None
        while time.monotonic() < nav_deadline:
            r = call("Runtime.evaluate",
                     {"expression": "({readyState: document.readyState, href: location.href})",
                      "returnByValue": True}, timeout=left())
            got = (r.get("result") or {}).get("value") or {}
            state, href = str(got.get("readyState") or ""), str(got.get("href") or "")
            if href and not href.startswith("about:"):
                if state == "complete" or (state == "interactive" and href == prev_href):
                    final_url = href
                    break
                prev_href = href
            time.sleep(0.4)
        check_blocked()
        if not final_url:
            raise CdpError(f"页面在 {NAV_TIMEOUT_S}s 内未完成导航:{url[:80]}(**不返回可能是旧页面的内容**)")
        # 第二道防线:重定向可能把我们带进内网(DNS rebinding 也在这一步现形)
        assert_fetchable_url(final_url, what="最终落地 URL")

        if wait_selector:
            sel_deadline = time.monotonic() + 10
            while time.monotonic() < sel_deadline:
                hit = call("Runtime.evaluate", {"expression": f"!!document.querySelector({json.dumps(wait_selector)})",
                                                "returnByValue": True},
                           timeout=max(0.1, sel_deadline - time.monotonic()))
                if (hit.get("result") or {}).get("value") is True:
                    break
                time.sleep(0.3)
            else:
                raise CdpError(f"等待选择器 {wait_selector!r} 超时")
        # 🔴 href 与正文必须**同一次 evaluate 原子取回**。分两次取的话,页面完全可以在两次之间
        #    用 setTimeout / meta refresh 跳到内网页 —— 于是内网正文被挂在公网 URL 名下,
        #    成为一条"看着成功"的错误证据(Codex core-retrieval-r3 P1)。
        got = call("Runtime.evaluate",
                   {"expression": "({href: location.href, text: (document.body && document.body.innerText) || ''})",
                    "returnByValue": True})
        val = (got.get("result") or {}).get("value") or {}
        text, text_url = str(val.get("text") or ""), str(val.get("href") or "")
        check_blocked()
        assert_fetchable_url(text_url, what="取正文时的 URL")     # 取的瞬间它在哪,就按哪里判
        if text_url != final_url:
            raise CdpError(f"取正文期间页面发生跳转({final_url[:50]} → {text_url[:50]}),放弃(**不产出错误归因的证据**)")
        if not text.strip():
            raise CdpError(f"页面正文为空:{final_url[:80]}(可能被拦截 / 需登录 / 纯 canvas;**不当成功证据**)")
        return text, final_url
    finally:
        if ws:
            ws.close()
        try:
            _http_json(f"/json/close/{tab_id}", timeout=5)
        except CdpError:
            pass                        # 关不掉标签页不该让取数失败,但上面已尽力


def is_available() -> bool:
    """CDP 是否可用(doctor 用来给出"可选增强未启用"这种**不算失败**的提示)。"""
    try:
        _http_json("/json/version", timeout=2)
        return True
    except CdpError:
        return False
