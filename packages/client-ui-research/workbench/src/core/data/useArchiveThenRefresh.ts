/**
 * 「先给存档，再后台刷新」—— 打开页面**不让人干等**。
 *
 * 资讯 / 信号这类页面，取一次上游要好几秒到几十秒。原来的做法是打开就转圈，
 * 转完才有东西看；而后端其实存着上一次的快照 —— 那份存档立刻就能给。
 *
 * ⇒ 三步：① 先读存档并渲染出来；② 同时在后台真取一次，界面上标「刷新中」；
 *        ③ 取到了就换上，取不到**保留存档**并说明原因。
 *
 * 🔴 **刷新失败绝不清空已有内容**。把一屏存档换成一句"加载失败"，是拿一次网络抖动
 *    抹掉用户本来能看的东西 —— 而且他不会知道刚才那些去哪了。
 * 🔴 **第一次打开可能连存档都没有**（新机器）。那种情况下确实要等，界面要照实说在取，
 *    而不是显示"暂无数据"（那是把"还没取"说成"没有"）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ArchiveThenRefresh<T> {
  /** 当前该显示的数据：先是存档，刷新成功后换成新的 */
  data: T | null;
  /** 连存档都没有、也没取到 —— 这才是真的"没有" */
  err: string | null;
  /** 还没有任何东西可显示（第一次打开且没有存档） */
  loading: boolean;
  /** 正在后台刷新（此时页面上是存档，照常可读） */
  refreshing: boolean;
  /** 刷新失败了，但下面显示的仍是存档 —— 要让用户看见这句话 */
  staleNote: string | null;
  /** 手动再刷一次 */
  refresh: () => void;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useArchiveThenRefresh<T>(
  /** `load(false)` = 读存档；`load(true)` = 真取一次 */
  load: (refresh: boolean) => Promise<T>,
  /** 这些变了就重来一遍（比如换了查询对象、换了栏目） */
  deps: readonly unknown[] = [],
): ArchiveThenRefresh<T> {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [staleNote, setStaleNote] = useState<string | null>(null);

  // load 通常是行内箭头函数，每次渲染都是新的 —— 放进依赖会无限重来
  const loadRef = useRef(load);
  loadRef.current = load;
  // 卸载 / 换 deps 之后到达的结果一律丢弃：否则会写进已经不属于它的那一屏
  const runRef = useRef(0);
  /**
   * 谁占着刷新。
   * 🔴 存的是 **run 号**不是布尔:布尔会让"切到新查询"被上一次的在途请求锁死 ——
   *    新的那次直接 return,于是要么只显示旧存档、连刷新都没发生(且不报错),
   *    要么(新对象没有存档时)`loading` **永远是 true**。
   *    旧请求的结果本来就会被 run 号挡掉,不需要它顺带锁住新请求。
   */
  const busyRun = useRef<number | null>(null);

  const doRefresh = useCallback(async (run: number) => {
    if (busyRun.current === run) return;   // 只拦同一 run 的重入(狂点刷新)
    busyRun.current = run;
    setRefreshing(true);
    try {
      const fresh = await loadRef.current(true);
      if (runRef.current !== run) return;
      setData(fresh);
      setErr(null);
      setStaleNote(null);
    } catch (e) {
      if (runRef.current !== run) return;
      // 🔴 有存档就**留着**，只把失败说出来；一个字都没有时才算真错
      setData((prev) => {
        if (prev === null) setErr(msg(e));
        else setStaleNote(`刷新没成功（${msg(e)}）——下面仍是上一次的存档`);
        return prev;
      });
    } finally {
      // 只放**自己**那把锁:新 run 已经接管时别把它的锁一起清了
      if (busyRun.current === run) busyRun.current = null;
      if (runRef.current === run) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const run = ++runRef.current;
    setLoading(true);
    setErr(null);
    setStaleNote(null);
    setData(null);
    void (async () => {
      try {
        const archived = await loadRef.current(false);
        if (runRef.current !== run) return;
        setData(archived);
        setLoading(false); // 存档已经能看了，剩下的在后台刷
      } catch {
        // 没有存档（新机器 / 上游从没成功过）：继续走下面那次真取，界面保持"正在取"
        if (runRef.current !== run) return;
      }
      await doRefresh(run);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const refresh = useCallback(() => void doRefresh(runRef.current), [doRefresh]);

  return { data, err, loading, refreshing, staleNote, refresh };
}
