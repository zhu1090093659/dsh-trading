---
'@dshtrading/client-ui-special-indicators': patch
---

桥缓存落盘：宿主重启后首个请求直接命中，不再每次冷拉上游。

成因：内存 TTL 缓存随宿主进程退出清零，而浏览器侧缓存按 origin 隔离——桌面壳每次启动挑随机空闲端口，origin 一变上个会话的 sessionStorage/localStorage 整片成孤儿，于是「重启一次 = 冷拉一次」。

- FinanceClient 新增 persistence 注入端口（load 同步补水 / save 异步原子写），落盘到 $DSH_HOME/special-indicators/cache.json：v1 信封 + baseUrl 指纹（换过上游地址即判废）、条目保留写入时刻（跨进程继续按同一 TTL 判定陈旧）、7 天保鲜期（覆盖周末与长假）、256 条上限（板块明细按代码分键防无界增长）；读写失败一律静默降级为慢。
- 新增 Config.cacheFile（空 = 默认路径）；新增依赖 @dshtrading/dsh-home。
