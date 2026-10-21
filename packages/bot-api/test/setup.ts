/**
 * 测试全局 setup：把定时任务账本指到每测试文件独立的临时目录。
 *
 * apply() 在 web 宿主面会构造 TasksLedger（目录锁 + 文件账本 + 调度器）——
 * 不重定向的话，跑一次测试就会在真实 ~/.dsh/trading-tasks/ 建账本、多文件
 * 并行时还会互相抢锁。单个需要多实例的测试文件（tasks-bridge）自行覆盖此
 * env 以获得独立账本。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-vitest-'))
process.env.DSH_TRADING_TASKS_LEDGER = join(dir, 'ledger-v1.json')

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    // Windows 上伪 ctx 丢掉了 `ctx.effect` 返回的清理函数，账本的
    // `*.writer-lease.sqlite` 仍被本进程打开，unlink 报 EBUSY；POSIX 允许删除
    // 被打开的文件，所以本机与 ubuntu 从不暴露。这里断言的对象是账本语义、
    // 不是临时目录的回收，故只吞 Windows 的文件占用错误，其余照旧抛。
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EBUSY' && code !== 'EPERM') throw error
  }
})
