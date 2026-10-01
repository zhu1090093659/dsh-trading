/**
 * 信号检测器（把"世界发生了什么"变成 %%MonitorSignals%% 里的读数）。
 *
 * 计划里这三条被点名为"谁去发现"的缺口：ENOSPC、时钟漂移、交易所错误计数。
 * 时钟漂移已由 %%clock-drift.ts%% 覆盖；本模块补另外两条 —— 它们此前**只有信号字段、没有生产者**，
 * 于是 %%scanDegradation%% 永远看到"写没失败、错误数为 0"，等于这两条降级路径从未真正生效。
 *
 * 共同立场：**只产读数、不做决策**（降级与否由 decideDegradation 定）；
 * 并且**查不到就报查不到**，不把"没测"表现为"正常"。
 *
 * @module @dshtrading/tractl/detectors
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WriteProbeResult {
  readonly writable: boolean
  /** 抛错时的 errno 代码（ENOSPC / EACCES / EROFS …），可写时 undefined。 */
  readonly code?: string | undefined
  readonly reason: string
}

/**
 * 真去写一小段再删掉，回报目录可写性。
 *
 * 为什么是"真写"而不是查 %%statfs%%：**能查到的空间不等于写得进去**（配额、只读挂载、inode 耗尽、
 * 容器层限制都可能在空间充足时报错）。审计与 journal 是这套系统的命根子，所以这里用最贵也最准的办法。
 * @param dir - 要探测的目录（不存在则尝试创建）。
 * @param options.probeName - 探针文件名（默认带 .probe 后缀，便于识别与清理）。
 */
export function probeWritable(dir: string, options: { readonly probeName?: string } = {}): WriteProbeResult {
  const probePath = join(dir, options.probeName ?? '.dsh-write-probe')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probePath, String(Date.now()))
    rmSync(probePath, { force: true })
    return { writable: true, reason: '写入探针成功' }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined
    // 探针失败要尽力清理（清理失败不影响判断）
    try {
      rmSync(probePath, { force: true })
    } catch {
      /* 清理失败无所谓 */
    }
    return {
      writable: false,
      ...(code === undefined ? {} : { code }),
      reason:
        code === 'ENOSPC'
          ? '磁盘满（ENOSPC）：拒绝新增风险'
          : code === 'EROFS'
            ? '只读文件系统（EROFS）：拒绝新增风险'
            : code === 'EACCES' || code === 'EPERM'
              ? '无写权限（' + String(code) + '）：拒绝新增风险'
              : '写入探针失败' + (code === undefined ? '' : '（' + code + '）'),
    }
  }
}

export interface VenueErrorStreak {
  recordOk(): void
  /** 记一次错误，返回当前连续错误数。 */
  recordError(kind?: string): number
  streak(): number
  lastKind(): string | undefined
  thresholdReached(): boolean
}

/**
 * 交易所错误连续计数（**成功即清零**）。
 *
 * 语义要点：只有**连续**错误才说明"交易所不正常"；偶发错误（限频一次、单个请求超时）不该把档位拉下去。
 * 清零由**任何一次成功**触发，而不是"等一段时间" —— 时间窗会让恢复变慢且难以解释。
 * @param options.threshold - 达到该连续次数即视为交易所不正常（<=0 视为禁用）。
 */
export function createVenueErrorStreak(options: { readonly threshold: number }): VenueErrorStreak {
  let streak = 0
  let lastKind: string | undefined
  return {
    recordOk() {
      streak = 0
      lastKind = undefined
    },
    recordError(kind) {
      streak += 1
      lastKind = kind
      return streak
    },
    streak: () => streak,
    lastKind: () => lastKind,
    thresholdReached: () => options.threshold > 0 && streak >= options.threshold,
  }
}
