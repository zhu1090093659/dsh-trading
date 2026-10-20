"""把进程的 stdio 钉死成 UTF-8。**入口在打任何 JSON 之前调它。**

🔴 中文 Windows 的管道默认 GBK：含 `\xa0` 的中文会当场 `UnicodeEncodeError`，
   其余中文会被写成 GBK 字节，而 Node 侧按 UTF-8 读 —— 全成乱码。
   来源：开源版 Vibe-Research issue #27；本仓库用 `PYTHONIOENCODING=gbk` 实测同样成立。

⚠️ **这份实现与 `.agents/skills/data-access/scripts/core/stdio_utf8.py` 必须一致**
   （三个包各自独立、互相 import 不到，所以只能各放一份）。
   完整来龙去脉写在那一份里；`calc/tests/test_stdio_utf8.py` 会钉死三份的函数体逐字相同，改一处漏一处会红。
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
