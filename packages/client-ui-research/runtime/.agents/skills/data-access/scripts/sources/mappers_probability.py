"""宏观概率(第 18 层)映射:每条合约一条证据;护栏原样进 note。

口径:
  - 预测市场是**全市场读数,与本公司无关** → 全市场证据 `symbol="MARKET"`,模块 / 场所 / 合约放 record_key
    (与大宗温度计、招聘信号同规矩)。
  - `value` 是**概率本身**(0–1 的小数),`unit="概率"`;成交量另存 `extra`,不做成证据 —— 它是**判断这条概率
    可不可信的元数据**,不是研究结论要引用的数字。
  - `period` 用**合约结算日**:它天然就是"下一个数据点"(FOMC 会议日、CPI 发布日),裁决点可以直接用。
    🔴 **缺结算日的合约一律丢弃,绝不拿取数日顶替** —— `period` 是结构化字段、下游直接当"下一个数据点"用,
    填成今天就是造了个日期;note 里写一句"结算日不详"救不回来(Codex prob-r8)。
  - 概率随时在变 → `as_of` 必带(**完整时刻**,不只是日期),note 里再强调一次"只在 as_of 那一刻成立"。
    ⚠️ 用的是**这条 item 那次请求**的时刻,不是整轮取数的开工时刻 —— 一轮会跨几十秒甚至跨 UTC 午夜,
    拿开工时刻给全部概率盖章,那句声称就是空话(Codex prob-r3)。

🔴 三条是审计打出来的,改这个文件前先看(Codex prob-r1):
  1. **`raw_ref` 必须取每条 item 自己的**。原先按场所取一个(`refs[venue]`),而那只是**第一次广度请求**的
     raw —— 第 2 页与定向系列拿到的合约,证据指向的文件里根本没有它,"每个数字都能追到 raw"就成了假的。
  2. **上游给的 `warnings` 不能丢**。定向取数遇到 429 / 5xx / 结构漂移时只降成 warning,mapper 再一丢,
     最终 `status` 还是 `ok` —— 整个宏观经济模块静默消失,而外面看不出任何异常。
  3. **价格口径要写进证据**(`price_type`:ask / last / outcome_price)。ask 与 last 是两种东西,
     没有标识就无法跨合约、跨场所比较,读者也无从判断这个数字是报价还是成交。
"""
from __future__ import annotations

import hashlib

from sources.mappers import ev, out
from sources.probability import CORE_MODULES

#: 价格口径 → 给人看的说法。证据里必须出现,别让读者以为都是同一种数。
PRICE_TYPE_LABEL = {"ask": "卖方报价(yes ask)", "last": "最后成交价", "outcome_price": "结果价(Yes 腿)"}


def _rk(item: dict) -> str:
    """record_key = 模块:场所:合约。限长 32 以便进温度计历史序列(超长用短哈希,原值仍在 note)。"""
    base = f"{item.get('module', '')}:{item.get('venue', '')}:{item.get('ticker', '')}"
    if len(base) <= 32:
        return base
    head = f"{item.get('module', '')}:{item.get('venue', '')}:"
    return (head + hashlib.sha256(str(item.get("ticker", "")).encode()).hexdigest())[:32]


def macro_probability_map(result: dict, ctx: dict) -> dict:
    result = result or {}
    today = str(result.get("today") or "")
    as_of = str(result.get("as_of") or today)
    guard = str(result.get("guard") or "")
    items = result.get("items") or []
    refs = result.get("raw_refs") or {}
    errors = result.get("errors") or []
    warnings = result.get("warnings") or []
    evs = []
    mapped: list = []          # **真正生成了证据**的条目 —— extra 与自检都只能基于它
    missing_close = 0
    for it in items:
        ictx = {**ctx, "symbol": "MARKET", "market": "US"}       # 两个场所都在美国
        leg = f"({it['leg']})" if it.get("leg") else ""
        vol = it.get("volume") or 0.0
        # 缺字段与真实零是两回事:上游改名导致字段没了,不能写成"24h 成交量为 0"当事实
        if it.get("volume_missing"):
            vol_txt = "24h 成交量字段缺失(上游未给,不是零)"
            thin = "⚠️ 拿不到成交量,无法判断这条概率的可信度;"
        else:
            vol_txt = f"24h 成交量 {vol:.0f}"
            thin = "⚠️ 24h 成交量为 0,这条概率参考价值很低;" if vol <= 0 else ""
        ptype = PRICE_TYPE_LABEL.get(str(it.get("price_type") or ""), "口径不明")
        close = str(it.get("close") or "")
        if not close:
            # 到这一步还没有结算日 = 源层契约被破坏。**不拿取数日顶替**,直接跳过并在 degraded 出声
            missing_close += 1
            continue
        evs.append(ev(ictx, "macro_probability", round(float(it["prob"]), 4), "概率",
                      close, currency="n/a",
                      # 优先用**这条 item 那次请求**的时刻;运行级只是兜底。
                      # 精确到秒的时刻保留在 extra.as_of 与 raw 里,这里按契约只到日
                      # (`ev()` 统一截断,别在这里再截一遍 —— 两处各截一次迟早不一致)
                      as_of=str(it.get("as_of") or as_of),
                      record_key=_rk(it),
                      # 每条挂**装着它的那次响应**的 raw;万一上游没给就退回场所级(并在下面标 degraded)
                      raw_ref=it.get("raw_ref") or refs.get(it.get("venue")),
                      note=f"[{it['module']}] {it['venue']} 合约「{it['title']}」{leg}的市场定价概率"
                           f"(口径:{ptype});结算日 {close}(period_basis=settlement);{vol_txt};{thin}{guard}"))
        mapped.append(it)
    extra = {"as_of": as_of, "modules": list(CORE_MODULES), "per_module_cap": result.get("per_module_cap"),
             "horizon_days": result.get("horizon_days"), "dropped": result.get("dropped") or {},
             # 诊断用:某模块静默清零(多半是分类器坏了)只看报告发现不了。**不进报告。**
             "empty_modules_diagnostic": result.get("empty_modules_diagnostic") or [],
             # 🔴 只列**已生成证据**的条目:按全部 items 生成会留下"有元数据、无证据"的孤儿记录,
             #    它们以 `_rk(item)` 为键、看着像某条真证据的配套数据,下游按它枚举就会拿到不存在的合约
             #    (Codex prob-r9 —— 这是我上一轮"跳过缺日期条目"时引入的)。
             "volumes": {_rk(i): i.get("volume") for i in mapped},
             "price_types": {_rk(i): i.get("price_type") for i in mapped},
             "volume_total": {_rk(i): i.get("volume_total") for i in mapped},
             "open_interest": {_rk(i): i.get("open_interest") for i in mapped}}
    deg = []
    if missing_close:
        deg.append(f"{missing_close} 条合约缺结算日已丢弃(证据的 period 是结构化字段,不拿取数日顶替)")
    src_missing = int((result.get("dropped") or {}).get("missing_close") or 0)
    if src_missing:
        # 源层丢的也要出声:只躺在 extra.dropped 里,看报告的人不会发现
        deg.append(f"源层另有 {src_missing} 条合约因缺 / 非法结算日被丢弃")
    if errors:
        deg.append("单个源失败:" + "; ".join(errors)[:180])
    if warnings:
        # 🔴 定向取数被限流 / 结构漂移只降成 warning,丢了它整块模块会静默消失而外面看不出异常
        deg.append("取数告警:" + "; ".join(warnings)[:240])
    if any(not i.get("raw_ref") for i in mapped):   # 同上:被跳过的条目没有需要溯源的证据
        deg.append("部分条目缺自己的 raw_ref,已退回场所级引用(溯源精度下降)")
    if not items:
        # 🔴 只有**两个源都成功**时才能说"都没有符合条件的合约"。一个源取数失败时它的状态是
        # **未知**,断言它没有合约是个假事实 —— 源层不再抛异常之后这句话就变错了(Codex prob-r4)。
        ok = [n for n in (result.get("sources_ok") or []) if n]          # **完整查完**的源
        part = [n for n in (result.get("sources_partial") or []) if n]    # 查了但覆盖不全的源
        if len(ok) >= 2:
            deg.append("两个预测市场当前都没有符合条件的合约(有量、未过期、非远期僵尸盘)")
        elif ok and part:
            deg.append(f"{ok[0]} 当前没有符合条件的合约;{part[0]} 的定向取数未查完,其覆盖范围内的情况未知")
        elif ok:
            deg.append(f"{ok[0]} 当前没有符合条件的合约;另一个源取数失败,其状态未知")
        elif len(part) >= 2:
            deg.append("两个源的取数都未查完,当前无结果不代表市场上没有合约")
        elif part:
            # 一个未查完 + 另一个报错,不能写成"两个都未查完" —— 同一段 degraded 里出现
            # 互相矛盾的状态描述,本身就在削弱证据链的可信度(Codex prob-r7)
            other = "另一个源取数失败" if errors else "另一个源没有结果"
            deg.append(f"{part[0]} 的取数未查完;{other};当前无结果不代表市场上没有合约")
        else:
            deg.append("两个源都没有可用结果")
    return out(evs, extra=extra, status="partial" if deg else "ok",
               degraded="; ".join(deg) if deg else None)
