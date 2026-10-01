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
  rmSync(dir, { recursive: true, force: true })
})
