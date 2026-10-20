"""数据源库:每个上游源一个模块(从 simonlin1212/a-stock-data 与 global-stock-data 的 SKILL.md 代码块移植),
函数只负责"取到结构化结果",不写信封;信封 / 证据由 mappers + fetch_endpoint 统一完成。
所有 HTTP 走 _http(自动落盘 raw);东财走 _http.em(跨进程串行);美股官方源走 _http.official_get(限流 + UA 声明)。
"""
