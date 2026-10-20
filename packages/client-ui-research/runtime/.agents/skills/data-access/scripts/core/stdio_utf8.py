"""把进程的 stdio 钉死成 UTF-8。**每个会往 stdout 打 JSON 的入口都要在第一行调它。**

🔴 为什么需要（来自开源版 Vibe-Research 的 issue #27，本仓库实测同样成立）：
    Python 的 `sys.stdout` 在**管道**里用的是 `locale.getpreferredencoding()` ——
    中文 Windows 上就是 GBK。我们的信封里全是中文（字段名、note、读法护栏），于是：

    ① 含 `\\xa0`（不换行空格，网页抓来的文本里到处都是）等 GBK 编不出的字符
       → `UnicodeEncodeError`，进程直接挂；
    ② 就算侥幸编得出，写出去的也是 GBK 字节，而 Node 侧是
       `Buffer.concat(out).toString("utf8")` 按 UTF-8 读 —— **中文全成乱码**。

    本机实测（`PYTHONIOENCODING=gbk` 模拟中文 Windows）：同一个端点，UTF-8 下产出合法
    UTF-8；GBK 下产出的字节在 `0xb2` 处就不是合法 UTF-8 了。**两次退出码相同、都不报错。**

⚠️ **不改成 `ensure_ascii=True`**：那样确实也能防崩，但会把所有中文变成 `\\uXXXX`
    转义、体积翻几倍，而且解决不了「Node 按 UTF-8 读 GBK 字节」那一半。
    重配编码才是对的做法（与上游 #27 的结论一致）。

⚠️ `errors="replace"`：真遇到编不出的字符时，宁可让那个字符变成 `?` 也不要整条产出没了 ——
    JSON 结构还在，调用方至少能拿到一份可解析的信封并看出哪里不对。
"""

from __future__ import annotations

import sys


def force_utf8_stdio() -> None:
    """把 stdin / stdout / stderr 重配为 UTF-8。可重复调用。

    🔴 **stdin 用 strict，stdout / stderr 用 replace** —— 两端的取舍是相反的：
       进来的字节坏了必须**当场报错**（`replace` 会把坏字节悄悄变成 `\ufffd`，
       而 JSON 往往仍能解析成功 ⇒ 用一个被篡改过的标的代码去查数、还照常返回）；
       出去的内容坏了则宁可让那一个字符变成 `?` 也不要整条产出没了 —— JSON 结构还在，
       调用方至少拿得到一份可解析的信封。（Codex 审计 r6 P2）

    🔴 **stdout 重配失败必须抛** —— 吞掉它等于"以为已经是 UTF-8 了"，
       于是本文件要解决的那个问题原样复活：中文写成 GBK 字节 / 遇 `\xa0` 直接崩，
       而且此刻没有任何人知道防线没生效。stderr 只承载诊断信息，失败可以容忍。
    """
    for stream, errors, required in (
        (sys.stdin, "strict", False),
        (sys.stdout, "replace", True),
        (sys.stderr, "replace", False),
    ):
        # 被重定向成非 TextIOWrapper 时（测试里常见）没有 reconfigure
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            if required:
                raise RuntimeError("stdout 不支持重配编码，无法保证输出是 UTF-8")
            continue
        try:
            reconfigure(encoding="utf-8", errors=errors)
        except (ValueError, OSError) as exc:
            if required:
                raise RuntimeError(f"stdout 重配 UTF-8 失败，输出可能是乱码：{exc}") from exc
            # stdin / stderr：读不到 / 写不出会在各自用到时自己报错，不必在这里拦住整个进程
